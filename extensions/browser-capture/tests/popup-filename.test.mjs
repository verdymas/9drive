import assert from 'node:assert/strict'
import { explicitFilenameFromDialog } from '../src/popup-filename.js'

assert.equal(explicitFilenameFromDialog({ suggestedFilename: '55234234e.vid', dialogValue: '55234234e.vid' }), null)
assert.equal(explicitFilenameFromDialog({ suggestedFilename: '55234234e.vid', dialogValue: 'My Video.mp4' }), 'My Video.mp4')
assert.equal(explicitFilenameFromDialog({ suggestedFilename: 'video bagus.mp4', dialogValue: 'video bagus.mp4', existingCustomFilename: 'video bagus.mp4' }), 'video bagus.mp4')
assert.equal(explicitFilenameFromDialog({ suggestedFilename: '55234234e.vid', dialogValue: '   ' }), null)

console.log('popup-filename: 4 checks passed')
