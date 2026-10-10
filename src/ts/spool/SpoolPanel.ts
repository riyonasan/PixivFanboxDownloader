export {}
const parent = document.querySelector('#spoolProofStatus')?.closest('details')?.parentElement
if (parent) {
  const panel = document.createElement('details')
  panel.className = 'option'
  const title = document.createElement('summary')
  title.textContent = 'ミニPCへの設定反映・保存／Eagle登録状況'
  const apply = document.createElement('button')
  apply.type = 'button'
  apply.textContent = 'ミニPCへ反映'
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.textContent = '状態を確認'
  const output = document.createElement('div')
  output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto'
  output.setAttribute('aria-live','polite')
  const request = async (msg: string, values = {}) => {
    const response = await chrome.runtime.sendMessage({ msg, ...values })
    if (response?.error || !response?.result) throw new Error(response?.error || 'ミニPCから応答がありません')
    return response.result
  }
  apply.addEventListener('click', async () => {
    apply.disabled = true
    try {
      await request('spool_apply')
      output.textContent = '設定を補助サービスへ保存し、読み戻しを確認しました。専用ブラウザの反映状況は「状態を確認」で確認できます。'
    } catch (error) { output.textContent = error instanceof Error ? error.message : '反映に失敗しました' }
    finally { apply.disabled = false }
  })
  refresh.addEventListener('click', async () => {
    refresh.disabled = true
    try {
      const status = await request('spool_status')
      output.replaceChildren()
      output.append(`新規取得: ${status.acquisitionPaused ? '容量不足で停止中' : '受付可能'} / 空き ${(status.freeBytes / 1024 ** 3).toFixed(1)} GiB\n`)
      output.append(`設定: ${status.configurationRevision && status.configurationRevision === status.appliedRevision ? '専用ブラウザへ反映済み' : '専用ブラウザの反映待ち'}\n`)
      output.append(`Eagle登録済み: ${status.counts.done || 0} / 確認待ち: ${status.counts.held || 0}\n最近の受付（最大200件）\n`)
      const labels: Record<string,string> = { pending:'登録待ち',retry:'接続待ち',submitting:'送信意図を保存済み',checking:'登録を照合中',held:'確認待ち',done:'登録済み',not_submitted:'登録対象外' }
      for (const item of status.items) {
        const row = document.createElement('p')
        row.textContent = `${item.fileName}\n${item.saveState === 'saved' ? 'ミニPCへ保存済み' : '転送未完了'} / Eagle${labels[item.eagleState] || item.eagleState}${item.reason ? ` (${item.reason})` : ''}`
        if (item.eagleState === 'held') {
          const resend = document.createElement('button')
          resend.type = 'button'
          resend.textContent = '未登録を確認して再送'
          resend.addEventListener('click', async () => {
            if (!window.confirm('Eagleの登録先・元投稿URL・画像を確認し、このファイルが登録されていないことを確認しましたか？ 成否不明のまま再送すると重複する可能性があります。')) return
            resend.disabled = true
            try {
              await request('spool_resubmit',{receiptId:item.receiptId,confirmNotRegistered:true})
              row.append('\n再送を受け付けました。状態を更新してください。')
            } catch (error) { row.append(`\n${error instanceof Error ? error.message : '再送に失敗しました'}`); resend.disabled = false }
          })
          row.append(resend)
        }
        output.append(row)
      }
    } catch (error) { output.textContent = error instanceof Error ? error.message : '状態を取得できませんでした' }
    finally { refresh.disabled = false }
  })
  panel.append(title,apply,refresh,output)
  parent.prepend(panel)
}
