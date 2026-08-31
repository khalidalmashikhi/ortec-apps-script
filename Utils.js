function escapeHtml_(value){
  return String(value||'').replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function saveSettings(settings, sessionToken){
  requireRole_(['OWNER','ADMIN'], sessionToken);
  Object.entries(settings||{}).forEach(([key,value])=>{
    const existing=findBy_(ORTEC.SHEETS.SETTINGS,'key',key);
    if(existing){
      updateById_(ORTEC.SHEETS.SETTINGS,'key',key,{
        value:String(value),updated_at:nowIso_(),updated_by:getCurrentUser(sessionToken).username || getCurrentUser(sessionToken).email
      });
    }else{
      appendObject_(ORTEC.SHEETS.SETTINGS,{
        key,value:String(value),description:'',updated_at:nowIso_(),updated_by:getCurrentUser(sessionToken).username || getCurrentUser(sessionToken).email
      });
    }
  });
  return {ok:true};
}
