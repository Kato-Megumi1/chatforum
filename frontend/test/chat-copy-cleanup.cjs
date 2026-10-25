const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path');
const { parse } = require('@vue/compiler-sfc');
const names = ['AnswerPreferences', 'AssistantComposer', 'ArtifactReview', 'CodeWorkspace', 'FileArtifacts', 'WebSearchSources', 'RagEvidence'];
const file = name => readFileSync(join(__dirname, '../src/' + (name === 'Chat' ? 'views/' : 'components/') + name + '.vue'), 'utf8');
const template = name => parse(file(name)).descriptor.template.content;

test('chat surfaces remove fixed explanations from templates instead of concealing them with CSS', () => {
  const source = [...names, 'Chat'].map(template).join('\n');
  for (const removed of ['内容由 AI 生成，重要信息请核实', '一个问题，一个想法', '原附件保留', '基础排版',
    '默认仅记住当前会话', '密钥和接口地址仅由服务端维护', '与普通 / Agent 独立',
    '页面验收不代表所有业务与交互测试均已通过', '相关文件内容会发给所选模型', '回到对话告诉编程 Agent',
    '场景图谱 ·', '已尝试', '历史标记不代表本轮已核验']) {
    assert.equal(source.includes(removed), false, 'Removed fixed explanation remains: ' + removed);
  }
  for (const name of ['Chat', 'CodeWorkspace', 'FileArtifacts', 'ArtifactReview'])
    assert.equal(/assistant-footnote|workspace-safety|workspace-intro|review-scope/.test(file(name)), false, 'No stale hiding selectors for removed copy');
});

test('useful controls and concise true failures survive the copy cleanup', () => {
  const chat = template('Chat'), preferences = template('AnswerPreferences'), workspace = template('CodeWorkspace'), review = template('ArtifactReview');
  assert.match(chat, /v-if="!selectedModel\?\.available"[^>]+title="当前模型不可用"/);
  assert.match(chat, /角色扮演/); assert.match(chat, /旧会话只读/);
  assert.match(preferences, /aria-label="回答设置"/); assert.match(preferences, /aria-label="深度思考"/); assert.match(preferences, /aria-label="联网搜索"/);
  assert.equal(preferences.includes('<small>'), false);
  assert.match(workspace, /上传文件/); assert.match(workspace, /新建文件/); assert.match(workspace, /删除此文件/); assert.match(workspace, /下载修改版/);
  assert.match(file('CodeWorkspace'), /ElMessageBox\.confirm\(/); assert.match(file('CodeWorkspace'), /本机原件和已发送的消息不受影响/);
  assert.match(review, /验收记录暂不可查看/); assert.match(review, /此截图暂不可查看/); assert.match(review, /重试/);
  assert.match(template('WebSearchSources'), /联网搜索暂不可用/);
});

test('citation/version identity and actual uncertainty remain, without public debugging counters', () => {
  const evidence = template('RagEvidence');
  assert.match(evidence, /c\.documentVersion/); assert.match(evidence, /metadata\.indexVersion/);
  assert.match(evidence, /source\.documentVersion/); assert.match(evidence, /source\.indexVersion/);
  assert.match(evidence, /原文线索与角色理解/); assert.match(evidence, /有些细节尚未确认/);
  assert.match(evidence, /metadata\.state === 'needs_review' && metadata\.diagnostics\?\.finalFailure/);
  assert.match(evidence, /引用暂不可访问/);
  assert.match(evidence, /metadata\.citations\?\.length \|\| \['grounded', 'needs_review'\]\.includes\(metadata\.state\)/,
    'Progress-only or unrelated metadata must not create an empty answer-evidence block');
  assert.equal(/metadata\.graph|metadata\.voiceRepairs|metadata\.searchAttempts|metadata\.historyEvidence/.test(evidence), false);
  assert.match(template('CodeWorkspace'), /file\.revision/); assert.match(template('CodeWorkspace'), /selectedChange\.baseRevision/);
});
