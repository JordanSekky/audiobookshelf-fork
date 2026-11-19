const chai = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fs = require('fs')
const EventEmitter = require('events')
const Stream = require('../../../server/objects/Stream')
const SocketAuthority = require('../../../server/SocketAuthority')
const Logger = require('../../../server/Logger')

const expect = chai.expect

describe('Stream', () => {
  let tmpDir
  let stream

  const libraryItem = {
    isPodcast: false,
    media: {
      getPlaybackDuration: () => 6000,
      getPlaybackTitle: () => 'Test Book'
    },
    toOldJSONExpanded: () => ({})
  }

  function writeSegments(segNums) {
    fs.mkdirSync(stream.streamPath, { recursive: true })
    segNums.forEach((n) => fs.writeFileSync(Path.join(stream.streamPath, `output-${n}.ts`), ''))
  }

  function range(start, end) {
    return Array.from({ length: end - start + 1 }, (_, i) => start + i)
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-stream-test-'))
    sinon.stub(SocketAuthority, 'clientEmitter')
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    // startTime 3000s -> segmentStartNumber floor((3000 - 30) / 6) = 495
    stream = new Stream('session-1', tmpDir, { id: 'user-1' }, libraryItem, null, 3000)
  })

  afterEach(() => {
    stream.stopWatcher()
    sinon.restore()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('checkFiles', () => {
    it('ignores segments left over from an earlier transcode', async () => {
      writeSegments([...range(100, 120), ...range(495, 500)])

      await stream.checkFiles()

      expect(stream.furthestSegmentCreated).to.equal(500)
    })

    it('stops at the first missing segment of the current run', async () => {
      writeSegments([495, 496, 498])

      await stream.checkFiles()

      expect(stream.furthestSegmentCreated).to.equal(496)
    })

    it('counts earlier segments once the current run reaches them', async () => {
      writeSegments([...range(495, 510), ...range(511, 530)])

      await stream.checkFiles()

      expect(stream.furthestSegmentCreated).to.equal(530)
    })
  })

  describe('checkSegmentNumberRequest', () => {
    it('does not reset again right after a seek when only stale segments exist', async () => {
      const resetStub = sinon.stub(stream, 'reset').resolves()
      writeSegments(range(100, 120))

      await stream.checkFiles()
      const result = await stream.checkSegmentNumberRequest(500)

      expect(result).to.equal(false)
      expect(resetStub.called).to.equal(false)
    })

    it('resets when the requested segment is far past the current run', async () => {
      const resetStub = sinon.stub(stream, 'reset').resolves()
      writeSegments(range(495, 500))

      await stream.checkFiles()
      const result = await stream.checkSegmentNumberRequest(600)

      expect(result).to.equal(600 * 6)
      expect(resetStub.calledOnceWith(600 * 6 - 6 * 5)).to.equal(true)
    })
  })

  describe('startWatcher', () => {
    it('adds segments when ffmpeg renames them from .tmp', async () => {
      fs.mkdirSync(stream.streamPath, { recursive: true })
      stream.startWatcher()
      const tmpPath = Path.join(stream.streamPath, 'output-495.ts.tmp')
      fs.writeFileSync(tmpPath, '')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(stream.segmentsCreated.size).to.equal(0)

      fs.renameSync(tmpPath, Path.join(stream.streamPath, 'output-495.ts'))
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(Array.from(stream.segmentsCreated)).to.deep.equal([495])
      expect(stream.furthestSegmentCreated).to.equal(495)
    })
  })

  describe('watcher events without a filename', () => {
    it('rescan the directory', () => {
      const fsExtra = require('../../../server/libs/fsExtra')
      let listener
      sinon.stub(fsExtra, 'watch').callsFake((path, cb) => {
        listener = cb
        return Object.assign(new EventEmitter(), { close() {} })
      })
      const checkFilesStub = sinon.stub(stream, 'checkFiles').resolves()

      stream.startWatcher()
      listener('rename', null)

      expect(checkFilesStub.calledOnce).to.equal(true)
    })
  })

  describe('startPolling', () => {
    let clock
    let checkFilesStub

    beforeEach(() => {
      clock = sinon.useFakeTimers()
      checkFilesStub = sinon.stub(stream, 'checkFiles').resolves()
      stream.watcher = { close() {} }
    })

    afterEach(() => {
      clearInterval(stream.loop)
      stream.watcher = null
    })

    it('polls every 2s until the stream is open', () => {
      stream.startPolling()
      clock.tick(6000)
      expect(checkFilesStub.callCount).to.equal(3)
    })

    it('polls every 10s once the stream is open', () => {
      stream.isClientInitialized = true
      stream.startPolling()
      clock.tick(20000)
      expect(checkFilesStub.callCount).to.equal(2)
    })
  })

  describe('onSegmentsUpdated', () => {
    it('throttles progress events', () => {
      stream.segmentsCreated.add(495)
      stream.onSegmentsUpdated()
      stream.segmentsCreated.add(496)
      stream.onSegmentsUpdated()

      const progressEmits = SocketAuthority.clientEmitter.getCalls().filter((call) => call.args[1] === 'stream_progress')
      expect(progressEmits.length).to.equal(1)
    })
  })

  describe('waitCancelTranscode', () => {
    it('resolves when ffmpeg emits error', async () => {
      const ffmpeg = new EventEmitter()
      stream.ffmpeg = ffmpeg
      const start = Date.now()
      const promise = stream.waitCancelTranscode()
      setTimeout(() => ffmpeg.emit('error', new Error('ffmpeg was killed with signal SIGKILL')), 10)

      expect(await promise).to.equal(true)
      expect(Date.now() - start).to.be.below(500)
    })

    it('resolves at once when ffmpeg already exited', async () => {
      stream.ffmpeg = null
      expect(await stream.waitCancelTranscode()).to.equal(true)
    })
  })
})
