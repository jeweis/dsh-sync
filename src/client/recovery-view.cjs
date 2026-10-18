const React = require('react')
const h = React.createElement
const button = (label, disabled, onClick, primary=false) => h('button',{type:'button',className:`vault-button${primary?' vault-primary':''}`,disabled,onClick},label)
const blocking = new Set(['runtime-version','local-dependency','recovery-plugin','recovery-install'])
const quote = (s,shell) => `'${s.replaceAll("'",shell==='powershell'?"''":"'\\''")}'`
function RecoveryGuide({active=true,host,state,run,disabled,t,snapshotLabel,open,setOpen}) {
  const [review,setReview]=React.useState(false)
  const [copyResult,setCopyResult]=React.useState(''),[id,setId]=React.useState(''),[source,setSource]=React.useState(''),[secret,setSecret]=React.useState(''),[keep,setKeep]=React.useState(true),[shell,setShell]=React.useState('posix')
  const ids=state.snapshots, selected=ids?.includes(id)?id:ids?.[0]??''
  const plan=state.recoveryPlan?.snapshotId===selected && (!source||state.recoveryPlan.selection.sourceProfile===source) && state.recoveryPlan.selection.useInstalled===keep?state.recoveryPlan:null
  const stage=review && plan && state.recoveryStage
  const command=stage?`${shell==='powershell'?'& ':''}${quote(stage.node,shell)} ${quote(stage.cli,shell)} finish-restore --home ${quote(stage.home,shell)} --request ${quote(stage.requestId,shell)} --offline`:''
  const ready=secret.length>=12&&secret.length<=1024
  const payload={id:selected,passphrase:secret,...source?{sourceProfile:source}:{},useInstalled:keep}
  const act=(action,extra={})=>{void run(action,{...payload,...extra})}
  const fields=(label,input)=>h('label',{className:'vault-field'},label,input)
  const pendingPackage=state.recoveryPackage
  const ref=React.useRef(null)
  React.useEffect(()=>{if(open) ref.current?.scrollIntoView?.({block:'start',behavior:'smooth'})},[open])
  React.useEffect(()=>{if(!active) {setSecret('');setOpen(false);setReview(false)}},[active])
  React.useEffect(()=>{if(open) ref.current?.querySelector('h4')?.focus()},[open,!!plan,!!stage])
  const reviewing=review && plan
  if(!open) return button(t('recoveryStart'),disabled,()=>{setReview(false);setOpen(true);if(ids===null)void run('list')})
  return h('section',{ref,className:'vault-subsection vault-recovery-guide','aria-label':t('recoveryTitle')},
    h('div',{className:'vault-heading'},h('h4',{tabIndex:-1},t(stage?'recoveryFinish':reviewing?'recoveryReview':'recoveryPick')),
      button(t('recoveryClose'),state.busy,()=>{setOpen(false);setSecret('');setReview(false);setCopyResult('')})),
    !reviewing&&h('div',{className:'vault-recovery-steps'},
      ids===null?h('p',null,t('notLoaded')):ids.length===0?h('p',null,t('recoveryEmpty')):h(React.Fragment,null,
        fields(t('selectSnapshot'),h('select',{value:selected,disabled,onChange:e=>{setId(e.target.value);setSource('');setSecret('')}},ids.map(value=>h('option',{key:value,value},snapshotLabel(value,t))))),
        button(t('recoveryRefresh'),disabled,()=>{void run('list')}),
        fields(t('recoverySecret'),h('input',{type:'password',value:secret,maxLength:1024,autoComplete:'off',disabled,onChange:e=>setSecret(e.target.value),onKeyDown:e=>{if(e.key==='Enter')e.preventDefault()}})),
        h('p',{className:'vault-muted'},t('recoverySecretHint')),
        h('details',{className:'vault-more'},h('summary',null,t('recoveryOptions')),h('label',{className:'vault-check'},h('input',{type:'checkbox',checked:keep,disabled,onChange:e=>setKeep(e.target.checked)}),t('recoveryKeepInstalled'))),
        button(t('recoveryCheck'),disabled||!ready,()=>{setReview(true);act('recovery-preview')},true))),
        reviewing&&!stage&&h(React.Fragment,null,
          button(t('recoveryBack'),state.busy,()=>setReview(false)),
          plan.profiles.length>1&&fields(t('recoverySource'),h('select',{value:plan.selection.sourceProfile,disabled,onChange:e=>{setSource(e.target.value);setReview(false)}},plan.profiles.map(p=>h('option',{key:p,value:p},p)))),
          h('p',null,t('recoveryDestination'),' ',h('strong',null,plan.selection.targetProfile)),
          h('p',null,t('recoverySummary').replace('{files}',String(plan.files.filter(f=>f.action!=='unchanged').length)).replace('{plugins}',String(plan.packages.length))),

          plan.blocked&&plan.warnings.some(w=>blocking.has(w.code)&&!plan.packages.some(p=>p.name===w.dependency&&['install','needs-install'].includes(p.state)))&&h('div',{role:'status',className:'vault-warning'},h('strong',null,t('recoveryNeedsAction')),
            h('ul',null,plan.warnings.filter(w=>blocking.has(w.code)&&!plan.packages.some(p=>p.name===w.dependency&&['install','needs-install'].includes(p.state))).map((w,i)=>h('li',{key:i},t(w.code==='runtime-version'?'recoveryRuntime':w.code==='recovery-install'?'recoveryInstallRequired':'recoveryLocalRequired'),w.dependency&&` ${w.dependency}`,w.code==='runtime-version'&&` ${plan.runtime.source} → ${plan.runtime.destination}`)))),
          plan.packages.some(p=>['install','needs-install'].includes(p.state))&&h('div',{className:'vault-table-scroll'},h('table',null,h('thead',null,h('tr',null,h('th',null,t('recoveryPlugin')),h('th',null,t('recoveryPluginState')),h('th',null,t('action')))),
            h('tbody',null,plan.packages.filter(p=>['install','needs-install'].includes(p.state)).map(p=>h('tr',{key:p.name},h('td',null,h('code',null,p.name)),h('td',null,t(`recoveryPackage-${p.state}`)),h('td',null,
              ['install','needs-install'].includes(p.state)&&host.recovery?.canInstall&&button(t('recoveryFindPackage'),disabled||!ready,()=>act('recovery-package',{name:p.name})))))))),
          pendingPackage&&h('div',{className:'vault-warning'},h('p',null,t('recoveryInstallConfirm'),' ',h('code',null,`${pendingPackage.name}@${pendingPackage.version}`)),h('p',{className:'vault-muted'},t('recoveryInstallSafety')),
            button(t('recoveryInstallButton'),disabled||!ready,()=>{act('recovery-install',{name:pendingPackage.name,token:pendingPackage.token});setKeep(true)})),
          h('details',{className:'vault-more'},h('summary',null,t('recoveryDetails')),h('p',null,t('recoveryMergeHint')),
            h('ul',null,plan.packages.map(p=>h('li',{key:p.name},p.name,' · ',t(`recoveryPackage-${p.state}`)))),
            h('ul',null,plan.files.map(f=>h('li',{key:f.path},t(f.action),' ',h('code',null,f.path)))),
            h('ul',null,plan.warnings.filter(w=>!blocking.has(w.code)).map((w,i)=>h('li',{key:i},t(w.code),w.dependency&&` ${w.dependency}`)))),
          !plan.blocked&&h(React.Fragment,null,
            h('p',{className:'vault-muted'},t('recoveryFinishHint')),
            button(t('recoveryPrepare'),disabled||!ready,()=>{act('recovery-stage',{token:plan.token});setSecret('')},true))),
          stage&&h('div',{role:'status',className:'vault-warning'},h('p',null,t('recoveryPrepared')),h('p',null,t('recoveryRunHint')),
            h('details',{className:'vault-more'},h('summary',null,t('recoveryCommandDetails')),fields(t('shell'),h('select',{value:shell,onChange:e=>setShell(e.target.value)},h('option',{value:'posix'},t('posix')),h('option',{value:'powershell'},t('powershell')))),
            h('pre',{className:'vault-commands',tabIndex:0},command)),
            button(t('recoveryCopy'),false,async()=>{try{await navigator.clipboard.writeText(command);setCopyResult('recoveryCopied')}catch{setCopyResult('recoveryCopyFailed');const details=ref.current?.querySelector('details');if(details)details.open=true}}),copyResult&&h('p',{role:'status'},t(copyResult)),
            h('p',{className:'vault-muted'},t('recoveryNoEnv')))
        )
}
module.exports={RecoveryGuide}
