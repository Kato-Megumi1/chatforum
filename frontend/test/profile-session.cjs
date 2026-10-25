const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  let epoch = 0;
  const calls = [], actions = [], messages = [], watchers = [], upload = deferred(), profile = deferred(), validation = deferred();
  const person = id => ({ id, username: 'Fixture ' + id, email: 'fixture' + id + '@example.test', bio: 'bio-' + id, avatar: '/uploads/avatars/old.png' });
  const store = { user: person(1), getAuthSession: () => ({ userId: store.user?.id ?? null, epoch }),
    setUser(value) { actions.push(['setUser', value.id]); store.user = value; }, clearAuth() { actions.push(['clearAuth']); epoch++; store.user = null; }, updateProfile: async () => undefined };
  const notify = () => { for (const watcher of watchers) { const next = watcher.getter(); const previous = watcher.value; watcher.value = next; watcher.callback(next, previous); } };
  const switchTo = id => { epoch++; store.user = id ? person(id) : null; notify(); };
  const imports = { vue: { ref: value => ({ value }), reactive: value => value, watch(getter, callback, options) {
    const watcher = { getter, callback, value: getter() }; watchers.push(watcher); if (options?.immediate) callback(watcher.value, undefined);
  } }, 'vue-router': { useRoute: () => ({ query: {} }), useRouter: () => ({ replace: async path => { actions.push(['replace', path]); } }) },
    '@/utils/api': { CONNECTION_SETTINGS_ENABLED: false }, '@/components/ForumActivity.vue': {},
    'element-plus': { ElMessage: { error: text => messages.push(['error', text]), success: text => messages.push(['success', text]), warning: text => messages.push(['warning', text]) } },
    '@/stores/user': { useUserStore: () => store }, '@/utils/registration-validation': { registrationPasswordError: () => null },
    '@/utils/request': { post(path, body) { calls.push({ path, body, session: store.getAuthSession() }); return path === '/users/avatar' ? upload.promise : Promise.resolve({}); },
      get(path) { calls.push({ path, session: store.getAuthSession() }); return profile.promise; } },
  };
  class FormDataFixture { fields = []; append(name, file) { this.fields.push({ name, file }); } }
  const source = readFileSync(join(__dirname, '../src/views/UserProfile.vue'), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const code = ts.transpileModule(source + '\nexport {handleAvatarFile,handleChangePassword,profileForm,passwordForm,passwordFormRef,avatarInput};', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'FormData', code)(name => { if (Object.hasOwn(imports, name)) return imports[name]; throw Error(name); }, mod, mod.exports, FormDataFixture);
  const input = { files: [{ name: 'fixture.png', size: 20, type: 'image/png' }], value: 'fixture.png' };
  mod.exports.avatarInput.value = input;
  mod.exports.passwordFormRef.value = { validate: () => validation.promise, clearValidate() {} };
  return { ...mod.exports, input, calls, actions, messages, upload, profile, validation, store, switchTo, person,
    send: () => mod.exports.handleAvatarFile({ target: input }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('avatar FormData goes through the identity-scoped request client and only matching profile writes back', async () => {
  const f = fixture(), pending = f.send();
  assert.equal(f.calls[0].path, '/users/avatar'); assert.equal(f.calls[0].body.fields[0].name, 'file');
  assert.equal(f.calls[0].session.userId, 1);
  f.upload.resolve({ url: '/uploads/avatars/new.png' }); await tick();
  assert.equal(f.calls[1].path, '/users/profile'); assert.equal(f.calls[1].session.userId, 1);
  f.profile.resolve({ ...f.person(1), avatar: '/uploads/avatars/new.png' }); await pending;
  assert.deepEqual(f.actions, [['setUser', 1]]); assert.equal(f.store.user.avatar, '/uploads/avatars/new.png');
  assert.deepEqual(f.messages, [['success', '头像更新成功']]); assert.equal(f.input.value, '');
});

test('a late upload success after A→B never starts a B profile request or claims success', async () => {
  const f = fixture(), pending = f.send(); f.switchTo(2);
  f.upload.resolve({ url: '/uploads/avatars/from-a.png' }); await pending;
  assert.equal(f.calls.length, 1); assert.equal(f.store.user.id, 2); assert.deepEqual(f.actions, []); assert.deepEqual(f.messages, []);
});

test('late A profile data after A→B cannot overwrite B or display an old success', async () => {
  const f = fixture(), pending = f.send(); f.upload.resolve({ url: '/uploads/avatars/from-a.png' }); await tick();
  assert.equal(f.calls.length, 2); f.switchTo(2); f.profile.resolve(f.person(1)); await pending;
  assert.equal(f.store.user.id, 2); assert.deepEqual(f.actions, []); assert.deepEqual(f.messages, []);
});

test('logout/relogin to the same id invalidates the old avatar operation epoch', async () => {
  const f = fixture(), pending = f.send(); f.switchTo(null); f.switchTo(1);
  f.upload.resolve({ url: '/uploads/avatars/previous-session.png' }); await pending;
  assert.equal(f.calls.length, 1); assert.deepEqual(f.actions, []); assert.deepEqual(f.messages, []);
});

test('wrong-account profile payload never writes a user even if the current session has not changed', async () => {
  const f = fixture(), pending = f.send(); f.upload.resolve({ url: '/uploads/avatars/new.png' }); await tick();
  f.profile.resolve(f.person(2)); await pending;
  assert.equal(f.store.user.id, 1); assert.deepEqual(f.actions, []); assert.deepEqual(f.messages, []);
});

test('session switches clear old editable personal data/passwords and stop a validated-old-password request', async () => {
  const f = fixture(); f.profileForm.bio = 'unsaved private A bio'; f.passwordForm.oldPassword = 'fixture old password'; f.passwordForm.newPassword = 'fixture new password';
  const pending = f.handleChangePassword(); f.switchTo(2); f.validation.resolve(true); await pending;
  assert.equal(f.profileForm.username, 'Fixture 2'); assert.equal(f.profileForm.bio, 'bio-2');
  assert.equal(f.passwordForm.oldPassword, ''); assert.equal(f.passwordForm.newPassword, '');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.actions, []); assert.deepEqual(f.messages, []);
});
