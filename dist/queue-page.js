async function refresh() {
  const result = await chrome.runtime.sendMessage({ msg: 'queue_status' })
  document.querySelector('#status').textContent = result?.error || `${result.jobs.length} jobs; queue capacity 1 GiB (browser quota may be lower).`
  const tbody = document.querySelector('#jobs'); tbody.replaceChildren()
  for (const job of result.jobs || []) {
    const row = document.createElement('tr')
    for (const value of [job.filename, job.size, job.state, job.error || '']) {
      const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell)
    }
    tbody.append(row)
  }
}
document.querySelector('#refresh').addEventListener('click', () => refresh().catch(e => document.querySelector('#status').textContent = String(e)))
refresh().catch(e => document.querySelector('#status').textContent = String(e))
