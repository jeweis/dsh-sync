const React = require('react')
const h = React.createElement
const button = (text,disabled,onClick) => h('button',{type:'button',className:'vault-button',disabled,onClick},text)
function ProviderGuide({plan,disabled,run,t}) {
  const [refs,setRefs]=React.useState(''),[shell,setShell]=React.useState('posix')
  const quote=value=>shell==='powershell'?`'${value.replaceAll("'","''")}'`:`'${value.replaceAll("'","'\\''")}'`
  const chosen=refs.split(/[\s,]+/).filter(Boolean)
  const args=plan&&!plan.blocked?`--home ${quote(plan.home)} --install-anchor ${quote(plan.installAnchor)} --mode ${plan.mode}${plan.mode==='enable'?` --refs ${quote(plan.refs.join(','))}`:''}`:''
  return h('div',{'aria-label':t('providerTitle')},
    h('h3',null,t('providerTitle')),h('p',{className:'vault-muted'},t('providerIntro')),
    h('label',{className:'vault-field'},t('providerRefs'),h('textarea',{value:refs,disabled,maxLength:16384,rows:2,placeholder:'DEEPSEEK_API_KEY',onChange:e=>setRefs(e.target.value)})),
    h('p',{className:'vault-muted'},t('providerRefsHint')),
    h('div',{className:'vault-actions'},button(t('providerEnablePreview'),disabled,()=>{void run('provider-preview',{mode:'enable',...(chosen.length?{refs:chosen}:{})})}),button(t('providerRollbackPreview'),disabled,()=>{void run('provider-preview',{mode:'rollback'})})),
    plan&&h(React.Fragment,null,
      h('h4',null,t(plan.mode==='enable'?'providerEnablePreview':'providerRollbackPreview')),
      plan.blocked?h('p',{role:'alert',className:'vault-warning'},t(plan.reason).startsWith('provider-')?t('provider-unsupported-config'):t(plan.reason)):
      h(React.Fragment,null,
        h('p',{className:'vault-warning'},t('providerAllWriters')),
        h('p',null,t('providerStorage'),' ',h('code',null,plan.storage)),
        h('p',null,t('providerManaged'),' ',plan.refs.join(', ')),
        h('div',{className:'vault-table-scroll'},h('table',null,h('thead',null,h('tr',null,h('th',null,'Profile'),h('th',null,t('file')),h('th',null,t('providerChange')))),h('tbody',null,plan.profiles.map(profile=>h('tr',{key:profile.name},h('td',null,profile.name),h('td',null,h('code',null,profile.path)),h('td',null,h('code',null,profile.fromId?`${profile.fromId} · ${profile.from}`:profile.from),' → ',h('code',null,profile.toId?`${profile.toId} · ${profile.to}`:profile.to))))))),
        h('p',{className:'vault-muted'},t(plan.mode==='enable'?'providerEnableEffect':'providerRollbackEffect')),
        h('details',null,h('summary',null,t('providerRetainedConfig')),h('pre',{className:'vault-commands'},JSON.stringify(plan.profiles.map(x=>({profile:x.name,config:x.retainedConfig??{}})),null,2))),
        h('h4',null,t('providerOffline')),h('p',{className:'vault-warning'},t('providerOfflineHint')),
        h('label',{className:'vault-field'},t('shell'),h('select',{value:shell,onChange:e=>setShell(e.target.value)},h('option',{value:'posix'},t('posix')),h('option',{value:'powershell'},t('powershell')))),
        h('pre',{className:'vault-commands',tabIndex:0},`dsh-sync provider-preview ${args}\ndsh-sync provider-switch ${args} --confirm PLAN_TOKEN_FROM_CLI --offline --all-writers-stopped`),
        h('p',{className:'vault-muted'},t('providerJournalHint')))))
}
function ProviderSetup({referenceMode, ...props}) {
  const [expanded, setExpanded] = React.useState(false)
  const {t} = props
  return h('details', {className:'vault-card vault-provider-advanced', onToggle:event=>{if(event.target === event.currentTarget && event.currentTarget.open) setExpanded(true)}},
    h('summary', null, t('providerAdvanced'), referenceMode === 'atomic' && h('span', null, ' · ', t('providerActive'))),
    expanded && h(React.Fragment, null,
      h('p', {className:'vault-muted'}, t('providerOptional')),
      h('p', {className:'vault-warning'}, t('providerCost')),
      h(ProviderGuide, props)))
}
module.exports={ProviderSetup}
