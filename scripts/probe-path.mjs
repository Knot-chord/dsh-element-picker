/** Probe one path: is it a junction/copy, and where does it really point? */
import { lstatSync, readlinkSync, realpathSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const targets = process.argv.slice(2)
for (const target of targets) {
  console.log('== ' + target)
  try {
    const info = lstatSync(target)
    console.log('  lstat: dir=' + info.isDirectory() + ' link=' + info.isSymbolicLink() + ' bytes=' + info.size)
  } catch (error) {
    console.log('  lstat failed: ' + (error.code || error.message))
    continue
  }
  try {
    console.log('  readlink: ' + readlinkSync(target))
  } catch (error) {
    console.log('  readlink: (not a link) ' + (error.code || ''))
  }
  try {
    console.log('  realpath: ' + realpathSync(target))
  } catch (error) {
    console.log('  realpath failed: ' + (error.code || error.message))
  }
  try {
    const entries = readdirSync(target)
    console.log('  entries: ' + entries.length + ' → ' + entries.slice(0, 8).join(', '))
  } catch (error) {
    console.log('  readdir failed: ' + (error.code || error.message))
  }
}
