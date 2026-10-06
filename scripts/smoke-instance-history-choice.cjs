// Actual Electron renderer and IPC. All data is synthetic and temporary;
// neither a real account nor the official Agent client is used.
const { app, safeStorage, dialog } = require('electron')
const fs = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const directory = process.env.CML_TEST_DATA_DIR
assert.ok(directory && fs.realpathSync(directory).startsWith(fs.realpathSync(tmpdir()) + sep) && basename(directory).startsWith('codex-manager-ui-'))
assert.equal(fs.existsSync(join(directory, 'state.vault')), false)
require('./test-vault.cjs').installTestVault(safeStorage)
const now = Date.now(), model = 'fixture-history-model'
const account = { id: randomUUID(), generation: randomUUID(), revision: 0, kind: 'api_key', name: '会话示例连接',
  baseUrl: 'https://fixture-history.invalid/v1', models: [model], wireApi: 'responses', defaultTier: 'inherit',
  note: '', tags: [], createdAt: now, credentials: { apiKey: 'fixture-history-secret' } }
fs.writeFileSync(join(directory, 'state.vault'), safeStorage.encryptString(JSON.stringify({ version: 1, settings: { refreshMinutes: 0, theme: 'light' }, groups: [], providers: [], accounts: [account] })), { mode: 0o600 })
const application = join(fs.realpathSync(directory), 'Fixture.app'), executable = join(application, 'Contents/MacOS/Codex')
fs.mkdirSync(join(application, 'Contents/MacOS'), { recursive: true })
fs.writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
let selectedDirectory
// Manual directory selection remains available alongside metadata discovery.
dialog.showOpenDialog = async (...args) => { const options = args.at(-1); return { canceled: false, filePaths: [options.properties?.includes('openDirectory') ? selectedDirectory : application] } }
globalThis.fetch = async () => { throw new Error('History choice smoke forbids external requests') }
function seedHistory(home) {
  const ids = Array.from({ length: 105 }, () => randomUUID())
  const projects = Array.from({ length: 12 }, (_, index) => ({ id: randomUUID(), name: `示例项目 ${String(index + 1).padStart(2, '0')}` + (index === 0 ? ' · 具有较长名称的工作空间完整显示在详情中' : ''), path: join(directory, 'projects', `project-${index + 1}`) }))
  projects.forEach(project => fs.mkdirSync(project.path, { recursive: true }))
  fs.mkdirSync(join(home, 'sessions'), { recursive: true }); fs.mkdirSync(join(home, 'archived_sessions'), { recursive: true })
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,model_provider TEXT,source TEXT,has_user_event INTEGER,archived INTEGER,project_id TEXT)')
  const assignments = {}, projectless = []
  ids.forEach((id, index) => {
    const archived = index < 32, project = projects[index % projects.length]
    const file = join(home, archived ? 'archived_sessions' : 'sessions', id + '.jsonl')
    const metadata = { timestamp: '2026-10-04T00:00:00.000Z', type: 'session_meta', payload: { id, cwd: project.path, model_provider: 'fixture_original_provider', source: 'cli', originator: 'codex_cli_rs' } }
    const body = { timestamp: '2026-10-04T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic history fixture' }] } }
    fs.writeFileSync(file, JSON.stringify(metadata) + '\n' + JSON.stringify(body) + '\n')
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id, file, project.path, 'fixture_original_provider', 'cli', 1, archived ? 1 : 0, null)
    if (index < 67) assignments[id] = { projectKind: 'local', projectId: project.id }
    else projectless.push(id)
  })
  db.close()
  fs.writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': Object.fromEntries(projects.map(project => [project.id, { id: project.id, name: project.name, rootPaths: [project.path], createdAt: now, updatedAt: now }])),
    'project-order': projects.map(project => project.id), 'thread-project-assignments': assignments, 'projectless-thread-ids': projectless }))
  return ids
}
const external = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'aml-history-source-'))); seedHistory(external)
const externalIndex=new DatabaseSync(join(external,'state_5.sqlite'))
externalIndex.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),join(external,'sessions','rollout-missing.jsonl'),external,'fixture_original_provider','cli',0,0,null)
externalIndex.close()
const cleanupExternal = () => fs.rmSync(external, { recursive: true, force: true })
process.on('exit', cleanupExternal)
app.on('will-quit', cleanupExternal)
fs.writeFileSync(join(external, 'config.toml'), 'model = ' + JSON.stringify(model) + '\n')
selectedDirectory = external
function snapshotFiles(home) {
  const files = {}
  const walk = (folder, relative = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name, file = join(folder, entry.name)
      if (entry.isDirectory()) walk(file, name)
      else if (entry.isFile()) files[name] = fs.readFileSync(file)
    }
  }
  walk(home); return files
}
const originalExternalFiles = snapshotFiles(external)
const output = resolve('.local/history-ui-polish')
fs.mkdirSync(output, { recursive: true })
for (const name of ['validation.json', 'failure.txt', 'failure.png']) fs.rmSync(join(output, name), { force: true })
const timer = setTimeout(() => { console.error('Instance history choice UI exceeded 75 seconds'); cleanupExternal(); app.exit(1) }, 75000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false); window.setContentSize(1280, 800)
  window.webContents.once('did-finish-load', async () => {
    const run = async code => {
      const result = await window.webContents.executeJavaScript(`(async()=>{try{return {value:await (${code})}}catch(error){return {error:String(error.stack??error)}}})()`)
      if (result.error) throw new Error(result.error + '\nRenderer expression: ' + code)
      return result.value
    }
    const wait = async expression => {
      const until = Date.now() + 10000
      while (!await run(expression)) { assert.ok(Date.now() < until, 'UI timeout: ' + expression); await new Promise(resolve => setTimeout(resolve, 30)) }
    }
    const visible = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')`
    const click = async (selector, text) => {
      const expression = `${visible(selector)}.find(el=>!el.disabled&&el.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g, ''))})`
      await wait(`!!(${expression})`); await run(`(${expression}).click()`)
    }
    const historyChoice = async kind => {
      const expression = `document.querySelector('[data-history-option="${kind}"]')`
      await wait(`!!(${expression})&&!(${expression}).disabled`); await run(`(${expression}).click()`)
    }
    const fill = async (selector, value) => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
      await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    }
    const step = index => wait(`(()=>{const el=document.querySelector('.instance-step[data-step="${index}"]');return !!el&&getComputedStyle(el).display!=='none'&&el.getClientRects().length>0})()`)
    const next = async index => { await click('.ant-modal-footer button', '下一步'); await step(index) }
    const selectSource = async label => {
      const control = await run(`(()=>{const select=document.querySelector('[aria-label="来源实例"]').closest('.ant-select');select.querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return select.querySelector('input').getAttribute('aria-controls')})()`)
      const option = `Array.from(document.getElementById(${JSON.stringify(control)})?.closest('.ant-select-dropdown')?.querySelectorAll('.ant-select-item-option')??[]).find(el=>el.textContent.includes(${JSON.stringify(label)}))`
      await wait(`!!(${option})`); await run(`(${option}).click()`)
    }
    const capture = async name => {
      await wait(`!${visible('.ant-message-notice')}.length`)
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      fs.writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
    }
    const layoutChecks = [], validationChecks = []
    const verifyLayout = async (name, modalSelector = '.instance-editor-dialog') => {
      await run('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const result = await run(`(()=>{
        const modal=Array.from(document.querySelectorAll(${JSON.stringify(modalSelector)})).find(el=>el.getClientRects().length),body=modal?.querySelector('.ant-modal-body'),footer=modal?.querySelector('.ant-modal-footer');
        if(!modal||!body||!footer)throw Error('Missing dialog/body/footer');
        const rect=modal.getBoundingClientRect(),fr=footer.getBoundingClientRect();
        const scrolls=Array.from(modal.querySelectorAll('*')).filter(el=>el.clientHeight>0&&el.scrollHeight>el.clientHeight+2&&['auto','scroll'].includes(getComputedStyle(el).overflowY));
        const summary=modal.querySelector('[aria-label="所选会话概况"]'),sb=summary?.getBoundingClientRect(),button=summary?.querySelector('[aria-label="查看项目"]')?.getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,bodyScrollHeight:body.scrollHeight,bodyHeight:body.clientHeight,scrollCount:scrolls.length,onlyBodyScroll:scrolls.every(el=>el===body),footerVisible:fr.top>=0&&fr.bottom<=innerHeight,dialogVisible:rect.top>=0&&rect.bottom<=innerHeight,summaryHeight:sb?.height,summaryButtonInside:!sb||!button||button.right<=sb.right&&button.left>=sb.left};
      })()`)
      assert.equal(result.footerVisible, true, name + ': footer remains visible')
      assert.equal(result.dialogVisible, true, name + ': dialog fits viewport')
      assert.equal(result.onlyBodyScroll, true, name + ': no nested scroll areas')
      assert.ok(result.scrollCount <= 1, name + ': at most one scroll area')
      assert.equal(result.summaryButtonInside, true, name + ': long names keep the details action inside the summary')
      layoutChecks.push({ name, ...result }); await capture(name + '.png')
    }
    const resize = async (width, height) => { window.setContentSize(width, height); await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
    const verifyValidation = async (name, expected, field) => {
      await step(2)
      await wait(`${visible('.instance-editor-dialog .ant-modal-footer .ant-alert')}.some(el=>el.innerText.includes(${JSON.stringify(expected)}))`)
      if (field) {
        await wait(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(field)}`)
        await wait(`(()=>{const modal=${visible('.instance-editor-dialog')}[0],input=modal.querySelector('[aria-label="${field}"]'),body=modal.querySelector('.ant-modal-body'),ir=input.getBoundingClientRect(),br=body.getBoundingClientRect();return ir.top>=br.top&&ir.bottom<=br.bottom})()`)
      }
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const result = await run(`(()=>{
        const modal=${visible('.instance-editor-dialog')}[0],body=modal.querySelector('.ant-modal-body'),footer=modal.querySelector('.ant-modal-footer');
        const alert=Array.from(footer.querySelectorAll('.ant-alert')).find(el=>el.getClientRects().length),ar=alert?.getBoundingClientRect(),fr=footer.getBoundingClientRect();
        const input=${field ? `modal.querySelector('[aria-label="${field}"]')` : 'null'},ir=input?.getBoundingClientRect(),br=body.getBoundingClientRect();
        return {step:2,message:alert?.innerText,errorVisible:!!ar&&ar.top>=0&&ar.bottom<=innerHeight,footerVisible:fr.top>=0&&fr.bottom<=innerHeight,
          focused:document.activeElement?.getAttribute('aria-label'),fieldInBody:!ir||ir.top>=br.top&&ir.bottom<=br.bottom,scrollTop:body.scrollTop};
      })()`)
      assert.equal(result.errorVisible, true, name + ': error stays visible in the footer')
      assert.equal(result.footerVisible, true, name + ': action footer stays visible')
      assert.equal(result.fieldInBody, true, name + ': invalid field is scrolled into view')
      if (field) assert.equal(result.focused, field, name + ': invalid control receives keyboard focus')
      validationChecks.push({ name, ...result }); await capture(name + '.png')
    }
    const keyboardChecks = async () => {
      assert.deepEqual(await run(`Array.from(document.querySelectorAll('[data-history-option]')).map(el=>({tag:el.tagName,tabIndex:el.tabIndex,label:el.getAttribute('aria-label')}))`),
        [{ tag: 'BUTTON', tabIndex: 0, label: '空白会话' }, { tag: 'BUTTON', tabIndex: 0, label: '从实例复制' }, { tag: 'BUTTON', tabIndex: 0, label: '从目录复制' }])
      await run(`document.querySelector('[data-history-option="empty"]').focus()`)
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      await wait(`document.activeElement?.getAttribute('data-history-option')==='instance'`)
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
      await wait(`document.querySelector('[data-history-option="instance"]').getAttribute('aria-pressed')==='true'`)
    }
    const beginWizard = async (name, expectedDefault = 'Codex 1') => {
      await click('.instances-panel .page-heading button', '创建实例'); await step(0)
      await click('.instance-step[data-step="0"] button', '选择应用文件')
      await wait('document.querySelector(".instance-step[data-step=\\"0\\"]").textContent.includes("Fixture.app")')
      await next(1); await next(2)
      assert.equal(await run('document.querySelector("[aria-label=实例名称]").value'), expectedDefault, 'New drafts receive an available client name')
      if (name !== undefined) await fill('[aria-label="实例名称"]', name)
    }
    try {
      await wait('!!document.querySelector(".instances-panel")')
      await beginWizard()
      assert.match(await run('document.querySelector(".instance-history-choice").innerText'), /空白会话.*从实例复制.*从目录复制/s)
      assert.equal(await run(`document.querySelector('[data-history-option="empty"]').getAttribute('aria-pressed')`), 'true')
      await verifyLayout('blank-1280x800')
      await resize(940, 680); await verifyLayout('blank-940x680'); await resize(1280, 800)
      await fill('[aria-label="实例名称"]', '')
      await next(3)
      assert.match(await run('document.querySelector(".instance-confirm").innerText'), /Codex 1/, 'Clearing a new name restores its available default before confirmation')
      await click('.ant-modal-footer button', '仅创建')
      await wait(`!${visible('.instance-wizard')}.length`)
      let snapshot = await run('window.manager.load()'), source = snapshot.instances[0]
      seedHistory(source.directory)
      const originalState = fs.readFileSync(join(source.directory, '.codex-global-state.json'), 'utf8'), originalSourceFiles = snapshotFiles(source.directory)
      const summary = await run(`window.manager.previewInstanceHistory({id:${JSON.stringify(source.id)},revision:${source.revision}})`)
      assert.equal(summary.sessions, 105); assert.equal(summary.archived, 32); assert.equal(summary.projects.length, 12); assert.equal(summary.projects.reduce((sum, project) => sum + project.sessions, 0), 67); assert.equal(summary.unassigned, 38)
      await beginWizard('项目会话副本', 'Codex 2')
      await keyboardChecks()
      await wait('document.querySelector(".instance-history-choice").innerText.includes("105")')
      assert.match(await run('document.querySelector(".instance-history-choice").innerText'), /38/)
      assert.equal(await run('document.querySelector("[aria-label=实例名称]").value'), '项目会话副本')
      assert.equal(await run('document.querySelector("[aria-label=实例模型]").value'), model)
      await verifyLayout('managed-1280x800')
      await resize(940, 680); await verifyLayout('managed-940x680')
      await fill('[aria-label="实例模型"]', '')
      const scrolled = await run(`(()=>{const body=${visible('.instance-editor-dialog')}[0].querySelector('.ant-modal-body');body.scrollTop=body.scrollHeight;return body.scrollTop})()`)
      assert.ok(scrolled > 0, 'The constrained dialog can hide the invalid model before validation')
      await click('.instance-editor-dialog .ant-modal-footer button', '下一步')
      await verifyValidation('missing-model-940x680', '模型', '实例模型')
      assert.ok(validationChecks.at(-1).scrollTop < scrolled, 'Validation scrolls back from the history summary to the missing model')
      assert.equal(await run('(async()=>{const s=await window.manager.load();return s.instances.length})()'), 1, 'Invalid drafts never mutate registered instances')
      await fill('[aria-label="实例模型"]', model)
      await click('.instance-history-choice button', '查看项目')
      await wait(`!!${visible('[aria-label="搜索项目"]')}.length`)
      await verifyLayout('projects-940x680', '.instance-history-detail-dialog')
      await fill('[aria-label="搜索项目"]', '示例项目 12')
      await wait(`document.querySelector('.instance-history-detail-dialog').innerText.includes('示例项目 12')`)
      assert.equal(await run(`Array.from(document.querySelectorAll('.instance-history-detail-dialog .history-project-row')).filter(el=>el.getClientRects().length).length`), 1)
      await capture('project-search-940x680.png')
      await fill('[aria-label="搜索项目"]', 'no-matching-fixture')
      await wait(`document.querySelector('.instance-history-detail-dialog').innerText.includes('没有匹配')`)
      await fill('[aria-label="搜索项目"]', '')
      await wait(`document.querySelectorAll('.instance-history-detail-dialog .history-project-row').length===12`)
      await resize(1280, 800); await verifyLayout('projects-1280x800', '.instance-history-detail-dialog')
      await click('.instance-history-detail-dialog .ant-modal-footer button', '关闭')
      await wait(`!${visible('[aria-label="搜索项目"]')}.length`)
      await click('.instance-history-choice button', '查看项目')
      await wait(`!!${visible('[aria-label="搜索项目"]')}.length`)
      const settings = await run('(async()=>{const s=await window.manager.load();return s.settings})()')
      await run(`window.manager.saveSettings(${JSON.stringify({ ...settings, theme: 'dark' })})`)
      await wait(`!!document.querySelector('.app-shell.dark')`)
      await capture('projects-dark-1280x800.png')
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await wait(`!${visible('[aria-label="搜索项目"]')}.length`)
      await step(2)
      assert.equal(await run(`document.querySelector('[data-history-option="instance"]').getAttribute('aria-pressed')`), 'true')
      assert.match(await run('document.querySelector(".instance-history-choice").innerText'), /105/)
      await capture('managed-dark-1280x800.png')
      await run(`window.manager.saveSettings(${JSON.stringify({ ...settings, theme: 'light' })})`)
      await wait(`!!document.querySelector('.app-shell:not(.dark)')`)
      await historyChoice('directory')
      assert.equal(await run(`!!document.querySelector('[aria-label="所选会话概况"]')`), false)
      assert.equal(await run('!!document.querySelector("[aria-label=来源实例]")'), false)
      await historyChoice('empty')
      assert.equal(await run('!!document.querySelector("[aria-label=来源客户端已关闭]")'), false)
      await historyChoice('instance')
      await wait('document.querySelector(".instance-history-choice").innerText.includes("105")')
      await next(3)
      assert.match(await run('document.querySelector(".instance-confirm").innerText'), /复制 · Codex 1/)
      assert.match(await run('document.querySelector(".instance-confirm").innerText'), /项目会话副本/, 'A custom instance name is preserved')
      await click('.ant-modal-footer button', '创建并预览')
      await wait('!!document.querySelector("[aria-label=启动会话概况]")')
      assert.match(await run('document.querySelector("[aria-label=启动会话概况]").innerText'), /105/)
      await capture('copied-history-launch-review.png')
      snapshot = await run('window.manager.load()')
      const copied = snapshot.instances.find(instance => instance.name === '项目会话副本')
      assert.ok(copied); assert.equal(copied.status, 'stopped'); assert.equal(snapshot.accounts.length, 1)
      assert.equal(fs.readFileSync(join(source.directory, '.codex-global-state.json'), 'utf8'), originalState)
      assert.deepEqual(snapshotFiles(source.directory), originalSourceFiles, 'Managed source files are unchanged')
      const preview = await run(`window.manager.previewInstanceLaunch({id:${JSON.stringify(copied.id)},revision:${copied.revision}})`)
      assert.equal(preview.history.projects.length, 12); assert.equal(preview.history.unassigned, 38)
      await click('.ant-modal-footer button', '取消')
      await wait('!document.querySelector("[aria-label=启动会话概况]")')
      await beginWizard('外部目录会话副本', 'Codex 2'); await historyChoice('directory')
      await click('.instance-history-choice button', '选择目录')
      await wait('document.querySelector(".instance-history-choice").innerText.includes("独立快照")')
      assert.equal(await run('!!document.querySelector("[aria-label=来源客户端已关闭]")'), false, 'Copying a snapshot does not require closing its source')
      await verifyLayout('directory-1280x800')
      await resize(940, 680); await verifyLayout('directory-940x680'); await resize(1280, 800)
      await next(3); await capture('external-history-confirmation.png')
      await click('.ant-modal-footer button', '仅创建')
      await wait(`!${visible('.instance-wizard')}.length`)
      await wait('(async()=>{const s=await window.manager.load();return s.instanceCopy?.status==="completed"&&s.instances.length===3})()')
      snapshot = await run('window.manager.load()')
      assert.equal(snapshot.instances.length, 3); assert.ok(snapshot.instances.every(instance => instance.status === 'stopped'))
      assert.equal(snapshot.instanceCopy.omittedSessions,1)
      await wait('document.querySelector(".instance-copy-job .ant-alert-warning")?.innerText.includes("已跳过 1 条")')
      await capture('snapshot-stale-index-notice.png')
      assert.deepEqual(snapshotFiles(source.directory), originalSourceFiles, 'Both copies preserve the original managed source')
      assert.deepEqual(snapshotFiles(external), originalExternalFiles, 'External source files are unchanged')
      const registryRoot=join(directory,'external-source-home','.antigravity_cockpit')
      fs.mkdirSync(registryRoot,{recursive:true})
      const registry=join(registryRoot,'codex_instances.json')
      const registryText=JSON.stringify({instances:[{id:'fixture-external',name:'本机外部工作空间',userDataDir:external,launchMode:'app',lastPid:process.pid}]})
      fs.writeFileSync(registry,registryText)
      await beginWizard('扫描来源副本','Codex 2');await historyChoice('instance')
      await wait('!document.querySelector(".instance-history-choice").innerText.includes("正在查找")')
      await selectSource('本机外部工作空间')
      await wait('document.querySelector(".instance-history-choice").innerText.includes("105")&&document.querySelector(".instance-history-choice").innerText.includes("独立快照")')
      assert.equal(await run('!!document.querySelector("[aria-label=来源客户端已关闭]")'),false)
      await resize(940,680);await verifyLayout('discovered-source-940x680');await capture('discovered-source-940x680.png')
      await next(3);await click('.ant-modal-footer button','仅创建')
      await wait('(async()=>{const s=await window.manager.load();return s.instanceCopy?.status==="completed"&&s.instances.length===4})()')
      assert.equal(fs.readFileSync(registry,'utf8'),registryText,'Metadata discovery preserves the other tool registry')
      assert.deepEqual(snapshotFiles(external),originalExternalFiles,'Discovered-source copy preserves all original files')
      await resize(1280,800)
      const openNavigation = async label => {
        const item = `${visible('.navigation .ant-menu-item')}.find(el=>el.textContent.includes(${JSON.stringify(label)}))`
        await wait(`!!(${item})`); await run(`(${item}).click()`)
      }
      const providerName = '表单校验示例供应商'
      await run(`window.manager.mutateProvider({action:'create',details:{name:${JSON.stringify(providerName)},baseUrl:'https://fixture-validation.invalid/v1',models:[${JSON.stringify(model)}],wireApi:'responses',defaultTier:'inherit'}})`)
      await openNavigation('供应商与密钥')
      await wait(`!!document.querySelector('.provider-detail')&&document.querySelector('.provider-detail').innerText.includes(${JSON.stringify(providerName)})`)
      await resize(940, 680); await click('.provider-detail button', '编辑供应商')
      await wait(`!!${visible('.ant-drawer-body .provider-details-form')}.length`)
      await fill('[aria-label="供应商名称"]', '')
      await run(`(()=>{const body=${visible('.ant-drawer-body')}[0];body.scrollTop=body.scrollHeight})()`)
      await click('.ant-drawer-footer button', '保存供应商')
      await wait(`${visible('.ant-drawer-footer .form-footer-feedback')}.some(el=>el.innerText.includes('请填写供应商名称'))`)
      await wait(`${visible('.ant-message-notice')}.some(el=>el.innerText.includes('请填写供应商名称'))`)
      await wait(`document.activeElement?.getAttribute('aria-label')==='供应商名称'`)
      await wait(`(()=>{const input=document.querySelector('[aria-label="供应商名称"]'),ir=input.getBoundingClientRect(),br=input.closest('.ant-drawer-body').getBoundingClientRect();return ir.top>=br.top&&ir.bottom<=br.bottom})()`)
      const providerValidation = await run(`(()=>{
        const alert=${visible('.ant-drawer-footer .form-footer-feedback')}[0],rect=alert.getBoundingClientRect(),input=document.querySelector('[aria-label="供应商名称"]'),ir=input.getBoundingClientRect(),body=input.closest('.ant-drawer-body'),br=body.getBoundingClientRect();
        return {message:alert.innerText,errorVisible:rect.top>=0&&rect.bottom<=innerHeight,toastVisible:${visible('.ant-message-notice')}.some(el=>el.innerText.includes('请填写供应商名称')),
          focused:document.activeElement===input,fieldVisible:ir.top>=br.top&&ir.bottom<=br.bottom,scrollTop:body.scrollTop};
      })()`)
      assert.equal(providerValidation.errorVisible, true, 'Provider errors remain visible below a scrolled form')
      assert.equal(providerValidation.toastVisible, true, 'Provider validation also creates actionable immediate feedback')
      assert.equal(providerValidation.focused, true, 'Provider validation focuses the missing name')
      assert.equal(providerValidation.fieldVisible, true, 'Provider validation scrolls back to reveal the missing name')
      assert.equal(await run(`(async()=>{const s=await window.manager.load();return s.providers.find(p=>p.name===${JSON.stringify(providerName)})?.name})()`), providerName, 'Invalid supplier name does not alter persisted data')
      await capture('provider-missing-name-940x680.png')
      await click('.ant-drawer-footer button', '取消')
      await wait(`!${visible('.ant-drawer-body .provider-details-form')}.length`)
      await click('.sidebar-bottom button', '设置')
      await wait('!!document.querySelector("[data-settings-field=port] input")')
      const settingsBeforeValidation = await run('(async()=>{const s=await window.manager.load();return s.settings})()')
      await fill('[data-settings-field="port"] input', '')
      await click('.settings-actions button', '保存设置')
      await wait(`${visible('.error-banner[role="alert"]')}.some(el=>el.innerText.includes('端口'))`)
      await wait(`${visible('.ant-message-notice')}.some(el=>el.innerText.includes('端口'))`)
      const settingsValidation = await run(`(()=>{const input=document.querySelector('[data-settings-field="port"] input'),field=input.closest('.ant-form-item');return {message:field.querySelector('.ant-form-item-explain-error')?.innerText,focused:document.activeElement===input,toastVisible:${visible('.ant-message-notice')}.some(el=>el.innerText.includes('端口'))}})()`)
      assert.match(settingsValidation.message, /端口/, 'Settings identify the missing local API port')
      assert.equal(settingsValidation.focused, true, 'Missing port receives focus')
      assert.deepEqual(await run('(async()=>{const s=await window.manager.load();return s.settings})()'), settingsBeforeValidation, 'Invalid settings never overwrite persisted configuration')
      await capture('settings-missing-port-940x680.png')
      await click('.settings-actions button', '放弃更改')
      await wait(`document.querySelector('[data-settings-field="port"] input').value===${JSON.stringify(String(settingsBeforeValidation.port))}`)
      fs.writeFileSync(join(output, 'validation.json'), JSON.stringify({ passed: true, blankDefault: true, managedSourceReadOnlyPreview: true, projectCounts: { sessions: 105, archived: 32, projects: 12, projectSessions: 67, unassigned: 38 },
        fourStepWizardPreserved: true, liveSnapshotWithoutClosure: true, staleIndexNotice:true, copiedTargetPreviewOnly: true, originalStateUnchanged: true, allSourceFilesUnchanged: true, instanceCount: 4, accountCount: 1,
        externalMetadataDiscovery:true,externalSourceSelection:true,externalRegistryUnchanged:true,discoveredLiveSnapshot:true,
        keyboardOptionsReachable: true, switchingClearsSource: true, projectSearch: true, detailEscapePreservesParent: true, lightAndDarkTheme: true,
        automaticName: true, automaticNameCollisionAvoided: true, clearedNameRestored: true, customNamePreserved: true, missingModelPreventsAdvance: true,
        validationChecks, providerValidation, settingsValidation, layoutChecks, realAccountsTouched: false, externalRequests: 0, officialClientLaunched: false }, null, 2))
      console.log('Instance history UI passed: blank/default wizard, source project/session summary, managed and live external snapshots, completed target launch preview; no real accounts, upstream calls or official client launch.')
      clearTimeout(timer); cleanupExternal(); app.exit(0)
    } catch (error) {
      console.error(error)
      fs.writeFileSync(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
      fs.writeFileSync(join(output, 'failure.txt'), await run('document.body.innerText'))
      clearTimeout(timer); cleanupExternal(); app.exit(1)
    }
  })
})
require('../out/main/index.js')
