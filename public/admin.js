function el(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function api(method,url,body){
  const res = await fetch(url,{
    method,
    headers: body ? {'content-type':'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials:'same-origin'
  });
  let data = null;
  try { data = await res.json(); } catch(e){}
  if(!res.ok) throw new Error((data && data.error) ? data.error : ('HTTP '+res.status));
  return data;
}

function showMsg(id,kind,text){
  const m = el(id);
  m.className = 'msg ' + kind;
  m.textContent = text;
}

let ME = null; // {username,name,role}

const ACTION_LABEL = {
  login: 'Signed in',
  draft_generated: 'Generated a draft',
  draft_copied: 'Copied a draft',
  policy_added: 'Added a policy',
  policy_edited: 'Edited a policy',
  policy_deleted: 'Deleted a policy',
  case_added: 'Saved a case',
  case_deleted: 'Deleted a case',
  account_reset: 'Reset an account to default'
};

function roleTag(role){
  if(role==='owner') return '<span class="tag owner">owner</span>';
  if(role==='admin') return '<span class="tag">admin</span>';
  return 'agent';
}

async function loadUsers(){
  const box = el('usersBox');
  box.className='muted'; box.textContent='Loading…';
  try{
    const rows = await api('GET','/api/users');
    if(!rows || !rows.length){ box.textContent='No accounts found.'; return; }
    box.className='';
    const isOwner = ME && ME.role==='owner';
    box.innerHTML =
      '<table><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr>' +
      rows.map(u => {
        let actions = '';
        if(u.role !== 'owner'){
          actions =
            '<button class="btn sec" data-reset="'+u.id+'">Reset password</button> '+
            (isOwner ? '<button class="btn sec" data-default="'+u.id+'">Reset to default</button> ' : '') +
            '<button class="btn sec" data-toggle="'+u.id+'" data-to="'+(u.active?0:1)+'">'+
            (u.active?'Disable':'Enable')+'</button>';
        } else {
          actions = '<span class="muted">Owner — self-service only</span>';
        }
        return '<tr><td>'+esc(u.name)+'</td><td>'+esc(u.username)+'</td>'+
        '<td>'+roleTag(u.role)+'</td>'+
        '<td>'+(u.active?'Active':'Disabled')+'</td>'+
        '<td style="text-align:right;white-space:nowrap;">'+actions+'</td></tr>';
      }).join('') + '</table>';
  }catch(e){
    box.className='';
    box.innerHTML='<div class="msg bad" style="display:block;">Could not load accounts: '+esc(e.message)+'</div>';
  }
}

async function loadUsage(){
  const box = el('usageBox');
  try{
    const rows = await api('GET','/api/usage');
    if(!rows || !rows.length){ box.className='muted'; box.textContent='No drafts generated yet.'; return; }
    box.className='';
    box.innerHTML =
      '<table><tr><th>Agent</th><th>Drafts</th><th>Input</th><th>Output</th><th>Last used</th></tr>' +
      rows.map(r =>
        '<tr><td>'+esc(r.username)+'</td><td>'+r.drafts+'</td>'+
        '<td>'+(r.input_tokens||0)+'</td><td>'+(r.output_tokens||0)+'</td>'+
        '<td>'+new Date(r.last_used).toLocaleString()+'</td></tr>'
      ).join('') + '</table>';
  }catch(e){
    box.className='muted'; box.textContent='Could not load usage: '+e.message;
  }
}

async function loadActivity(){
  const box = el('activityBox');
  box.className='muted'; box.textContent='Loading…';
  try{
    const rows = await api('GET','/api/activity?limit=300');
    if(!rows || !rows.length){ box.textContent='No activity logged yet.'; return; }
    box.className='';
    box.innerHTML =
      '<table><tr><th>Time</th><th>Agent</th><th>Role</th><th>Action</th><th>Detail</th></tr>' +
      rows.map(r =>
        '<tr><td>'+new Date(r.created_at).toLocaleString()+'</td>'+
        '<td>'+esc(r.name||r.username||'—')+'</td>'+
        '<td>'+roleTag(r.role)+'</td>'+
        '<td>'+esc(ACTION_LABEL[r.action]||r.action)+'</td>'+
        '<td>'+esc(r.detail||'')+'</td></tr>'
      ).join('') + '</table>';
  }catch(e){
    box.className='muted'; box.textContent='Could not load activity: '+e.message;
  }
}

el('btnAdd').addEventListener('click', async function(){
  const name = el('f_name').value.trim();
  const username = el('f_user').value.trim().toLowerCase();
  const password = el('f_pass').value;
  const role = el('f_role').value;

  if(!name){ showMsg('addMsg','bad','Enter a full name.'); return; }
  if(!/^[a-z0-9._-]{3,32}$/.test(username)){
    showMsg('addMsg','bad','Username must be 3-32 characters: lowercase letters, numbers, . _ - only.');
    return;
  }
  if(password.length < 8){ showMsg('addMsg','bad','Password must be at least 8 characters.'); return; }

  this.disabled = true;
  this.textContent = 'Creating…';
  try{
    await api('POST','/api/users',{name,username,password,role});
    showMsg('addMsg','ok','Created "'+username+'". Give them this username and password to sign in.');
    el('f_name').value=''; el('f_user').value=''; el('f_pass').value='';
    await loadUsers();
  }catch(e){
    showMsg('addMsg','bad', e.message);
  }finally{
    this.disabled = false;
    this.textContent = 'Create';
  }
});

el('btnChangePw').addEventListener('click', async function(){
  const current = el('pw_current').value;
  const next = el('pw_next').value;
  if(next.length < 8){ showMsg('pwMsg','bad','New password must be at least 8 characters.'); return; }
  this.disabled = true;
  try{
    await api('POST','/api/password',{current,next});
    showMsg('pwMsg','ok','Password changed.');
    el('pw_current').value=''; el('pw_next').value='';
  }catch(e){
    showMsg('pwMsg','bad', e.message);
  }finally{
    this.disabled = false;
  }
});

async function loadCases(){
  const box = el('casesBox');
  box.className='muted'; box.textContent='Loading…';
  try{
    const agents = await api('GET','/api/admin/cases');
    const total = agents.reduce((n,a)=>n+(a.cases?a.cases.length:0),0);
    if(!total){ box.className='muted'; box.textContent='No cases saved by any agent yet.'; return; }
    box.className='';
    box.innerHTML = agents.filter(a=>a.cases&&a.cases.length).map(a=>{
      const rows = a.cases.map(c=>{
        const s=c.summary||{};
        return '<tr><td>'+esc(c.timestamp||'')+'</td><td>'+esc(c.customer||'')+'</td>'+
          '<td>'+esc(c.store||'')+'</td><td>'+esc(s.category||'')+'</td><td>'+esc(s.outcome||'')+'</td>'+
          '<td><details><summary class="muted" style="cursor:pointer;">View</summary>'+
          '<div style="margin-top:8px;"><div class="muted" style="margin-bottom:4px;">Customer email</div>'+
          '<div style="white-space:pre-wrap;font-family:\'Courier New\',monospace;font-size:12px;background:#f6f3ec;border:1px solid #d8d1bf;padding:8px;border-radius:2px;margin-bottom:8px;">'+esc(c.email||'')+'</div>'+
          '<div class="muted" style="margin-bottom:4px;">Draft reply</div>'+
          '<div style="white-space:pre-wrap;font-family:Georgia,serif;font-size:13px;background:#f6f3ec;border:1px solid #d8d1bf;padding:8px;border-radius:2px;">'+esc(c.draft||'')+'</div></div>'+
          '</details></td></tr>';
      }).join('');
      return '<div style="margin-bottom:16px;">'+
        '<div style="font-family:\'Courier New\',monospace;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#5a5346;margin-bottom:6px;">'+
        esc(a.name)+' <span class="muted">('+esc(a.username)+') — '+a.cases.length+' case(s)</span></div>'+
        '<table><tr><th>Logged</th><th>Customer</th><th>Store</th><th>Category</th><th>Outcome</th><th></th></tr>'+rows+'</table></div>';
    }).join('');
  }catch(e){
    box.className='muted'; box.textContent='Could not load cases: '+e.message;
  }
}

el('btnReload').addEventListener('click', loadUsers);
el('btnReloadActivity').addEventListener('click', loadActivity);
el('btnReloadCases').addEventListener('click', loadCases);

el('usersBox').addEventListener('click', async function(e){
  const rid = e.target.getAttribute('data-reset');
  const tid = e.target.getAttribute('data-toggle');
  const did = e.target.getAttribute('data-default');
  if(rid){
    const pw = prompt('New password (8+ characters):');
    if(!pw) return;
    try{ await api('PATCH','/api/users/'+rid,{password:pw}); alert('Password updated.'); }
    catch(err){ alert('Failed: '+err.message); }
  }
  if(did){
    if(!confirm('Reset this account to a fresh system-generated password? The old password stops working immediately.')) return;
    try{
      const r = await api('POST','/api/users/'+did+'/reset-default',{});
      alert('Reset "'+r.username+'". New password:\n\n'+r.newPassword+'\n\nShare this with them securely.');
      await loadActivity();
    }
    catch(err){ alert('Failed: '+err.message); }
  }
  if(tid){
    try{ await api('PATCH','/api/users/'+tid,{active:Number(e.target.getAttribute('data-to'))}); await loadUsers(); }
    catch(err){ alert('Failed: '+err.message); }
  }
});

(async function init(){
  try{ ME = await api('GET','/api/me'); }catch(e){ ME = null; }
  loadUsers();
  loadUsage();
  loadActivity();
  loadCases();
})();
