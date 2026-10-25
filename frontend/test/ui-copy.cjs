// UI copy cleanup must remove redundant elements, not hide them with CSS.
const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path');
const { parse, compileTemplate } = require('@vue/compiler-sfc');
const read = file => readFileSync(join(__dirname, '../src', file), 'utf8');
const files = ['views/Forum.vue', 'views/CreatePost.vue', 'views/PostDetail.vue', 'views/KnowledgeBase.vue',
  'views/UserProfile.vue', 'views/UserSpace.vue', 'views/Notifications.vue', 'views/Messages.vue',
  'views/Login.vue', 'views/Register.vue', 'components/ForumActivity.vue'];

test('all simplified non-chat templates compile without removing content controls', () => {
  for (const filename of files) {
    const { descriptor, errors } = parse(read(filename), { filename });
    assert.deepEqual(errors, [], filename);
    assert(descriptor.template, filename);
    const result = compileTemplate({ source: descriptor.template.content, filename, id: 'ui-copy-fixture' });
    assert.deepEqual(result.errors, [], filename);
  }
});

test('redundant slogans and technical tutorials are absent from the templates', () => {
  const templates = files.map(filename => parse(read(filename)).descriptor.template.content).join('\n');
  for (const text of ['海棠花开，北洋情深', '一本小说，多次修订', '嵌入模型由服务端管理',
    '内置实体别名词表', '语义关系按问答场景渐进抽取', '共现不代表关系',
    '智能对话与社区交流平台', '加入 ChatForum 社区', '不进入模型记忆',
    '只保留你与社区成员的对话', '社区成员 · 私信', '同一条消息编号',
    '只搜索用户名，不查找或展示邮箱、手机号', '分享你的看法，也欢迎补充有用的信息',
    '友善交流，尊重他人', '后台检查更新并合并站内提醒', '去看看 TA 的主页']) {
    assert(!templates.includes(text), text);
  }
});

test('knowledge permissions, immutable versions and index progress stay visible', () => {
  const kb = read('views/KnowledgeBase.vue');
  for (const token of ['kb.chatUnavailableReason', 'kb.activeIndexVersion', 'kb.candidateIndexVersion',
    'doc.version', 'doc.status', 'prop="status"', '等待验证', '当前线上版本', '停止灰度',
    'inactive-text="受限访问"', 'aria-label="知识库访问范围"', "permission !== 'READ'", "permission === 'ADMIN'",
    'inactive-text="仅自己和管理员"', "shared: false", '模型费用', '确认你有权处理这些内容并同意发送']) {
    assert(kb.includes(token), token);
  }
});

test('errors, identity checks, input limits and private-message consent are retained', () => {
  const login = read('views/Login.vue'), profile = read('views/UserProfile.vue'), messages = read('views/Messages.vue');
  assert(login.includes('v-if="loginRejected"')); assert(login.includes('v-if="recoveryNotice"'));
  assert(login.includes('maxlength="6"')); assert(login.includes('resendSeconds'));
  assert(profile.includes('所有设备需重新登录')); assert(profile.includes('passwordRules'));
  assert(profile.includes('<button type="button" class="avatar-hint" @click="avatarInput?.click()">更换头像</button>'));
  for (const token of ['conversation.blocked', '接受请求', '拒绝', '消息请求已发送，等待对方接受',
    '发送结果未确认，请重试', ':maxlength="2000"', '屏蔽后双方无法继续私信', 'contactQuery.trim().length >= 2']) {
    assert(messages.includes(token), token);
  }
  const post = read('views/PostDetail.vue'), editor = read('views/CreatePost.vue');
  assert(post.includes('v-if="!readingPreferenceSaved" role="status"'));
  assert(post.includes('maxlength="4000"')); assert(post.includes('focusUnavailable'));
  assert(editor.includes('v-if="conflict"')); assert(editor.includes('savedLabel'));
  assert(editor.includes('maxlength="50000"')); assert(editor.includes('清除后不能恢复这份本机草稿'));
});
