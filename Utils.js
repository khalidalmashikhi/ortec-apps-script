function escapeHtml_(value){
  return String(value||'').replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function saveSettings(settings, sessionToken){
  const actor = requireCapability_('settings', sessionToken);
  Object.entries(settings||{}).forEach(([key,value])=>{
    const existing=findBy_(ORTEC.SHEETS.SETTINGS,'key',key);
    if(existing){
      updateById_(ORTEC.SHEETS.SETTINGS,'key',key,{
        value:String(value),updated_at:nowIso_(),updated_by:actor.username || actor.email
      });
    }else{
      appendObject_(ORTEC.SHEETS.SETTINGS,{
        key,value:String(value),description:'',updated_at:nowIso_(),updated_by:actor.username || actor.email
      });
    }
  });
  return {ok:true};
}
