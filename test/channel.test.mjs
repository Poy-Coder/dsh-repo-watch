/**
 * Where the watchtower can push, and what happens when it cannot.
 *
 * A DSH with no channel plugin has nowhere to deliver: the plugin used to hold the
 * messages in memory with no way to see it, so "why did I never get a push" had no
 * answer from inside the product.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { pushTargetName, _internals } from '../index.mjs'

const { runtime } = _internals
const withTools = (names) => ({ definitions: () => names.map((name) => ({ name })) })

test('no channel plugin means no target', () => {
  runtime.tools = withTools(['repo_watch_status', 'repo_watch_digest'])
  assert.equal(pushTargetName({}), '')
})

test('an empty runtime is not a crash', () => {
  runtime.tools = undefined
  assert.equal(pushTargetName({}), '')
})

test('the first channel wins when nothing is pinned', () => {
  runtime.tools = withTools(['repo_watch_status', 'feishu_send_message', 'wechat_send_message'])
  assert.equal(pushTargetName({}), 'feishu_send_message')
})

test('a pinned channel is used even when it is not first', () => {
  runtime.tools = withTools(['feishu_send_message', 'wechat_send_message'])
  assert.equal(pushTargetName({ pushTool: 'wechat_send_message' }), 'wechat_send_message')
})

test('a pinned channel that is not installed falls back to the first one', () => {
  runtime.tools = withTools(['feishu_send_message'])
  assert.equal(pushTargetName({ pushTool: 'telegram_send_message' }), 'feishu_send_message')
})

test('only tools ending in send_message are candidates', () => {
  runtime.tools = withTools(['wechat_list_messages', 'feishu_send_file', 'wechat_send_message'])
  assert.equal(pushTargetName({}), 'wechat_send_message')
})

test('a broken tool registry is reported as "no channel", not thrown', () => {
  runtime.tools = { definitions: () => { throw new Error('registry disposed') } }
  assert.equal(pushTargetName({}), '')
})
