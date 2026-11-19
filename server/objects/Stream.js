const EventEmitter = require('events')
const Path = require('path')
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')

const fs = require('../libs/fsExtra')
const Ffmpeg = require('../libs/fluentFfmpeg')

const { secondsToTimestamp } = require('../utils/index')
const { writeConcatFile } = require('../utils/ffmpegHelpers')
const { AudioMimeType } = require('../utils/constants')
const hlsPlaylistGenerator = require('../utils/generators/hlsPlaylistGenerator')
const AudioTrack = require('./files/AudioTrack')

class Stream extends EventEmitter {
  constructor(sessionId, streamPath, user, libraryItem, episodeId, startTime, transcodeOptions = {}) {
    super()

    this.id = sessionId
    this.user = user
    /** @type {import('../models/LibraryItem')} */
    this.libraryItem = libraryItem
    this.episodeId = episodeId

    this.transcodeOptions = transcodeOptions

    this.segmentLength = 6
    this.maxSeekBackTime = 30
    this.streamPath = Path.join(streamPath, this.id)
    this.concatFilesPath = Path.join(this.streamPath, 'files.txt')
    this.playlistPath = Path.join(this.streamPath, 'output.m3u8')
    this.finalPlaylistPath = Path.join(this.streamPath, 'final-output.m3u8')
    this.startTime = startTime

    this.ffmpeg = null
    this.loop = null
    this.isResetting = false
    this.isClientInitialized = false
    this.isTranscodeComplete = false
    this.segmentsCreated = new Set()
    this.furthestSegmentCreated = 0
    /** @type {import('fs').FSWatcher|null} */
    this.watcher = null
    this.lastProgressEmit = 0
    this.isCheckingFiles = false
  }

  /**
   * @returns {import('../models/PodcastEpisode') | null}
   */
  get episode() {
    if (!this.libraryItem.isPodcast) return null
    return this.libraryItem.media.podcastEpisodes.find((ep) => ep.id === this.episodeId)
  }
  get mediaTitle() {
    return this.libraryItem.media.getPlaybackTitle(this.episodeId)
  }
  get totalDuration() {
    return this.libraryItem.media.getPlaybackDuration(this.episodeId)
  }
  get tracks() {
    return this.libraryItem.getTrackList(this.episodeId)
  }
  get tracksAudioFileType() {
    if (!this.tracks.length) return null
    return this.tracks[0].metadata.ext.slice(1)
  }
  get tracksMimeType() {
    if (!this.tracks.length) return null
    return this.tracks[0].mimeType
  }
  get tracksCodec() {
    if (!this.tracks.length) return null
    return this.tracks[0].codec
  }
  get mimeTypesToForceAAC() {
    return [AudioMimeType.FLAC, AudioMimeType.OPUS, AudioMimeType.WMA, AudioMimeType.AIFF, AudioMimeType.WEBM, AudioMimeType.WEBMA, AudioMimeType.AWB, AudioMimeType.CAF]
  }
  get codecsToForceAAC() {
    return ['alac', 'ac3', 'eac3', 'opus']
  }
  get userToken() {
    return this.user.token
  }
  // Fmp4 does not work on iOS devices: https://github.com/advplyr/audiobookshelf-app/issues/85
  //   Workaround: Force AAC transcode for FLAC
  get hlsSegmentType() {
    return 'mpegts'
  }
  get segmentBasename() {
    return 'output-%d.ts'
  }
  get segmentStartNumber() {
    if (!this.startTime) return 0
    return Math.floor(Math.max(this.startTime - this.maxSeekBackTime, 0) / this.segmentLength)
  }
  get numSegments() {
    var numSegs = Math.floor(this.totalDuration / this.segmentLength)
    if (this.totalDuration - numSegs * this.segmentLength > 0) {
      numSegs++
    }
    return numSegs
  }
  get clientPlaylistUri() {
    return `/hls/${this.id}/output.m3u8`
  }
  get isAACEncodable() {
    return ['mp4', 'm4a', 'm4b'].includes(this.tracksAudioFileType)
  }
  get transcodeForceAAC() {
    return !!this.transcodeOptions.forceAAC
  }

  toJSON() {
    return {
      id: this.id,
      userId: this.user.id,
      libraryItem: this.libraryItem.toOldJSONExpanded(),
      episode: this.episode ? this.episode.toOldJSONExpanded(this.libraryItem.id) : null,
      segmentLength: this.segmentLength,
      playlistPath: this.playlistPath,
      clientPlaylistUri: this.clientPlaylistUri,
      startTime: this.startTime,
      segmentStartNumber: this.segmentStartNumber,
      isTranscodeComplete: this.isTranscodeComplete
    }
  }

  async checkSegmentNumberRequest(segNum) {
    const segStartTime = segNum * this.segmentLength
    if (this.segmentStartNumber > segNum) {
      Logger.warn(`[STREAM] Segment #${segNum} Request is before starting segment number #${this.segmentStartNumber} - Reset Transcode`)
      await this.reset(segStartTime - this.segmentLength * 5)
      return segStartTime
    } else if (this.isTranscodeComplete) {
      return false
    }

    if (this.furthestSegmentCreated) {
      const distanceFromFurthestSegment = segNum - this.furthestSegmentCreated
      if (distanceFromFurthestSegment > 10) {
        Logger.info(`Segment #${segNum} requested is ${distanceFromFurthestSegment} segments from latest (${secondsToTimestamp(segStartTime)}) - Reset Transcode`)
        await this.reset(segStartTime - this.segmentLength * 5)
        return segStartTime
      }
    }

    return false
  }

  async generatePlaylist() {
    await fs.ensureDir(this.streamPath)
    await hlsPlaylistGenerator(this.playlistPath, 'output', this.totalDuration, this.segmentLength, this.hlsSegmentType)
    return this.clientPlaylistUri
  }

  /**
   * @param {string} filename
   * @returns {number|null} segment number, or null if not a finished segment
   */
  parseSegmentFilename(filename) {
    const match = /^output-(\d+)\.ts$/.exec(filename || '')
    return match ? Number(match[1]) : null
  }

  startWatcher() {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(this.streamPath, (eventType, filename) => {
        // filename is not provided on every platform
        if (!filename) return this.checkFiles()
        const segNum = this.parseSegmentFilename(filename)
        if (segNum === null) return
        this.segmentsCreated.add(segNum)
        this.onSegmentsUpdated()
      })
      this.watcher.on('error', (error) => {
        Logger.warn(`[STREAM] ${this.id} segment watcher failed, polling instead`, error)
        this.stopWatcher()
        if (this.ffmpeg) this.startPolling()
      })
    } catch (error) {
      Logger.warn(`[STREAM] ${this.id} cannot watch segments, polling instead`, error)
      this.watcher = null
    }
  }

  stopWatcher() {
    if (this.watcher) this.watcher.close()
    this.watcher = null
  }

  /**
   * Fallback for missed watcher events
   */
  async checkFiles() {
    if (this.isCheckingFiles) return
    this.isCheckingFiles = true
    try {
      const files = await fs.readdir(this.streamPath)
      files.forEach((file) => {
        const segNum = this.parseSegmentFilename(file)
        if (segNum !== null) this.segmentsCreated.add(segNum)
      })

      if (!this.segmentsCreated.size) {
        Logger.warn('No Segments')
        return
      }
      this.onSegmentsUpdated()
    } catch (error) {
      Logger.error('Failed checking files', error)
    } finally {
      this.isCheckingFiles = false
    }
  }

  onSegmentsUpdated() {
    // End of the unbroken run from segmentStartNumber; stale segments from an earlier transcode don't count
    let seg = Math.max(this.furthestSegmentCreated, this.segmentStartNumber - 1)
    while (this.segmentsCreated.has(seg + 1)) seg++
    if (seg >= this.segmentStartNumber && seg > this.furthestSegmentCreated) {
      this.furthestSegmentCreated = seg
    }

    if (this.segmentsCreated.size > 6 && !this.isClientInitialized) {
      this.isClientInitialized = true
      Logger.info(`[STREAM] ${this.id} notifying client that stream is ready`)
      this.clientEmit('stream_open', this.toJSON())
    }

    if (Date.now() - this.lastProgressEmit >= 2000) {
      this.emitProgress()
    }
  }

  emitProgress() {
    this.lastProgressEmit = Date.now()

    var chunks = []
    var current_chunk = []
    var last_seg_in_chunk = -1

    var segments = Array.from(this.segmentsCreated).sort((a, b) => a - b)

    segments.forEach((seg) => {
      if (!current_chunk.length || last_seg_in_chunk + 1 === seg) {
        last_seg_in_chunk = seg
        current_chunk.push(seg)
      } else {
        if (current_chunk.length === 1) chunks.push(current_chunk[0])
        else chunks.push(`${current_chunk[0]}-${current_chunk[current_chunk.length - 1]}`)
        last_seg_in_chunk = seg
        current_chunk = [seg]
      }
    })
    if (current_chunk.length) {
      if (current_chunk.length === 1) chunks.push(current_chunk[0])
      else chunks.push(`${current_chunk[0]}-${current_chunk[current_chunk.length - 1]}`)
    }

    var perc = ((this.segmentsCreated.size * 100) / this.numSegments).toFixed(2) + '%'
    Logger.info('[STREAM-CHECK] Check Files', this.segmentsCreated.size, 'of', this.numSegments, perc, `Furthest Segment: ${this.furthestSegmentCreated}`)

    this.clientEmit('stream_progress', {
      stream: this.id,
      percent: perc,
      chunks,
      numSegments: this.numSegments
    })
  }

  startLoop() {
    this.clientEmit('stream_progress', { stream: this.id, chunks: [], numSegments: 0, percent: '0%' })
    this.startPolling()
  }

  startPolling() {
    clearInterval(this.loop)
    let ticks = 0
    // Fallback for missed watcher events: every 2s until the stream is open, then every 10s
    this.loop = setInterval(() => {
      if (this.watcher && this.isClientInitialized && ++ticks % 5 !== 0) return
      this.checkFiles()
    }, 2000)
  }

  async start() {
    Logger.info(`[STREAM] START STREAM - Num Segments: ${this.numSegments}`)

    /** @type {import('../libs/fluentFfmpeg/index').FfmpegCommand} */
    this.ffmpeg = Ffmpeg()
    this.furthestSegmentCreated = 0

    const adjustedStartTime = Math.max(this.startTime - this.maxSeekBackTime, 0)
    const trackStartTime = await writeConcatFile(this.tracks, this.concatFilesPath, adjustedStartTime)
    if (trackStartTime == null) {
      // Close stream show error
      this.ffmpeg = null
      this.close('Failed to write stream concat file')
      return
    }

    this.ffmpeg.addInput(this.concatFilesPath)
    // seek_timestamp : https://ffmpeg.org/ffmpeg.html
    // the argument to the -ss option is considered an actual timestamp, and is not offset by the start time of the file
    //   fixes https://github.com/advplyr/audiobookshelf/issues/116
    this.ffmpeg.inputOption('-seek_timestamp 1')
    this.ffmpeg.inputFormat('concat')
    this.ffmpeg.inputOption('-safe 0')

    if (adjustedStartTime > 0) {
      const shiftedStartTime = adjustedStartTime - trackStartTime
      // Issues using exact fractional seconds i.e. 29.49814 - changing to 29.5s
      var startTimeS = Math.round(shiftedStartTime * 10) / 10 + 's'
      Logger.info(`[STREAM] Starting Stream at startTime ${secondsToTimestamp(adjustedStartTime)} (User startTime ${secondsToTimestamp(this.startTime)}) and Segment #${this.segmentStartNumber}`)
      this.ffmpeg.inputOption(`-ss ${startTimeS}`)

      this.ffmpeg.inputOption('-noaccurate_seek')
    }

    const logLevel = process.env.NODE_ENV === 'production' ? 'error' : 'warning'

    let audioCodec = 'copy'
    if (this.transcodeForceAAC || this.mimeTypesToForceAAC.includes(this.tracksMimeType) || this.codecsToForceAAC.includes(this.tracksCodec)) {
      Logger.debug(`[Stream] Forcing AAC for tracks with mime type ${this.tracksMimeType} and codec ${this.tracksCodec}`)
      audioCodec = 'aac'
    }

    const codecOptions = [`-loglevel ${logLevel}`, '-map 0:a']

    if (['ac3', 'eac3'].includes(this.tracksCodec) && this.tracks.length > 0 && this.tracks[0].bitRate && this.tracks[0].channels) {
      // In case for ac3/eac3 it needs to be passed the bitrate and channels to avoid ffmpeg errors
      codecOptions.push(`-c:a ${audioCodec}`, `-b:a ${this.tracks[0].bitRate}`, `-ac ${this.tracks[0].channels}`)
    } else {
      codecOptions.push(`-c:a ${audioCodec}`)
    }

    this.ffmpeg.addOption(codecOptions)
    // temp_file: segments are written as .tmp and renamed when complete
    const hlsOptions = ['-f hls', '-copyts', '-avoid_negative_ts make_non_negative', '-max_delay 5000000', '-max_muxing_queue_size 2048', `-hls_time 6`, `-hls_segment_type ${this.hlsSegmentType}`, `-start_number ${this.segmentStartNumber}`, '-hls_playlist_type vod', '-hls_list_size 0', '-hls_allow_cache 0', '-hls_flags temp_file']
    this.ffmpeg.addOption(hlsOptions)
    if (this.hlsSegmentType === 'fmp4') {
      this.ffmpeg.addOption('-strict -2')
      var fmp4InitFilename = Path.join(this.streamPath, 'init.mp4')
      // var fmp4InitFilename = 'init.mp4'
      this.ffmpeg.addOption('-hls_fmp4_init_filename', fmp4InitFilename)
    }
    var segmentFilename = Path.join(this.streamPath, this.segmentBasename)
    this.ffmpeg.addOption('-hls_segment_filename', segmentFilename)
    this.ffmpeg.output(this.finalPlaylistPath)

    this.ffmpeg.on('start', (command) => {
      Logger.info('[INFO] FFMPEG transcoding started with command: ' + command)
      Logger.info('')
      if (this.isResetting) {
        Logger.info('[STREAM] Clearing isResetting')
        this.isResetting = false
      }
      this.startLoop()
    })

    this.ffmpeg.on('stderr', (stdErrline) => {
      Logger.info(stdErrline)
    })

    this.ffmpeg.on('error', (err, stdout, stderr) => {
      if (err.message && err.message.includes('SIGKILL')) {
        // This is an intentional SIGKILL
        Logger.info('[FFMPEG] Transcode Killed')
        this.ffmpeg = null
        clearInterval(this.loop)
      } else {
        Logger.error('Ffmpeg Err', '"' + err.message + '"')
        // ffmpeg has already exited. Clear the reference so reset() does not wait for it to close
        this.ffmpeg = null
        clearInterval(this.loop)

        // Temporary workaround for https://github.com/advplyr/audiobookshelf/issues/172 and https://github.com/advplyr/audiobookshelf/issues/2157
        const aacErrorMsg = 'ffmpeg exited with code 1'
        const errorMessageSuggestsReEncode = err.message?.startsWith(aacErrorMsg) && !err.message?.includes('No such file or directory')
        if (audioCodec === 'copy' && this.isAACEncodable && errorMessageSuggestsReEncode) {
          Logger.info(`[Stream] Re-attempting stream with AAC encode`)
          this.transcodeOptions.forceAAC = true
          this.reset(this.startTime)
        } else {
          // Close stream show error
          this.close(err.message)
        }
      }
    })

    this.ffmpeg.on('end', (stdout, stderr) => {
      Logger.info('[FFMPEG] Transcoding ended')
      // For very small fast load
      if (!this.isClientInitialized) {
        this.isClientInitialized = true

        Logger.info(`[STREAM] ${this.id} notifying client that stream is ready`)
        this.clientEmit('stream_open', this.toJSON())
      }
      this.isTranscodeComplete = true
      this.ffmpeg = null
      clearInterval(this.loop)
      Logger.info(`[Stream] ${this.mediaTitle} sending stream_ready`)
      this.clientEmit('stream_ready')
    })

    this.startWatcher()
    this.ffmpeg.run()
  }

  async close(errorMessage = null) {
    clearInterval(this.loop)
    this.stopWatcher()

    Logger.info('Closing Stream', this.id)
    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGKILL')
    }

    await fs
      .remove(this.streamPath)
      .then(() => {
        Logger.info('Deleted session data', this.streamPath)
      })
      .catch((err) => {
        Logger.error('Failed to delete session data', err)
      })

    if (errorMessage) this.clientEmit('stream_error', { id: this.id, error: (errorMessage || '').trim() })
    else this.clientEmit('stream_closed', this.id)

    this.emit('closed')
  }

  cancelTranscode() {
    clearInterval(this.loop)
    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGKILL')
    }
  }

  /**
   * Resolves when the current ffmpeg process exits, or false after 10s
   */
  async waitCancelTranscode() {
    const ffmpeg = this.ffmpeg
    if (!ffmpeg) return true
    const exited = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000)
      const onExit = () => {
        clearTimeout(timeout)
        resolve(true)
      }
      ffmpeg.once('error', onExit)
      ffmpeg.once('end', onExit)
    })
    if (!exited) Logger.error('[STREAM] Transcode never closed...')
    return exited
  }

  async reset(time) {
    if (this.isResetting) {
      return Logger.info(`[STREAM] Stream ${this.id} already resetting`)
    }
    time = Math.max(0, time)
    this.isResetting = true

    if (this.ffmpeg) {
      const exited = this.waitCancelTranscode()
      this.cancelTranscode()
      await exited
    }

    this.isTranscodeComplete = false
    this.startTime = time
    // this.clientCurrentTime = this.startTime
    Logger.info(`Stream Reset New Start Time ${secondsToTimestamp(this.startTime)}`)
    this.start()
  }

  clientEmit(evtName, data) {
    SocketAuthority.clientEmitter(this.user.id, evtName, data)
  }

  getAudioTrack() {
    var newAudioTrack = new AudioTrack()
    newAudioTrack.setFromStream(this.mediaTitle, this.totalDuration, this.clientPlaylistUri)
    return newAudioTrack
  }
}
module.exports = Stream
