// Existing optional-network smoke cases now enter through the collapsed settings
// section. Keep their account selection and return page intact across the modal.
exports.clickEntry = async (run, wait, selector) => {
  if (!['.proxy-resources-trigger', '.proxy-assignment-trigger'].includes(selector)) return false
  const accounts = await run('!!document.querySelector(".account-filters")')
  await run('document.querySelector(".sidebar-bottom button").click()')
  await wait('!!document.querySelector(".advanced-network .ant-collapse-header")')
  if (!await run('!!document.querySelector(".advanced-network .ant-collapse-item-active")')) {
    await run('document.querySelector(".advanced-network .ant-collapse-header").click()')
  }
  await wait(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`)
  await run(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait(`!!document.querySelector(${JSON.stringify(selector === '.proxy-resources-trigger' ? '.proxy-resources-panel' : '.proxy-assignment-dialog')})`)
  if (accounts) {
    await run('Array.from(document.querySelectorAll(".navigation .ant-menu-item")).find(el=>el.textContent.includes("账号管理")).click()')
    await wait('!!document.querySelector(".account-filters")')
  }
  return true
}
