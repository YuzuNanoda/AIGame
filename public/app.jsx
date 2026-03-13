const { useState, useCallback, useRef, useMemo, useEffect } = React;

const AVATARS = ['🦊','🐺','🦁','🐻','🦅','🐲','🦄','🐱','🐼','🐯','🐸','🐵','🐰','🐧','🐙','🐨'];
const AVA_NAMES = ['狐狸','灰狼','雄狮','棕熊','苍鹰','飞龙','独角兽','花猫','熊猫','猛虎','青蛙','猴子','兔子','企鹅','章鱼','考拉'];
const RM = {werewolf:'狼人',villager:'平民',seer:'预言家',witch:'女巫',hunter:'猎人',idiot:'白痴'};

const PERSONALITY_PRESETS = [
  { id:'tieba', label:'贴吧嘴臭老哥', desc:'说话刻薄毒舌，喜欢阴阳怪气' },
  { id:'depressed', label:'抑郁心理的少女', desc:'语气低沉消极，偶尔流露脆弱' },
  { id:'sneaky', label:'贱兮兮的坏人', desc:'油嘴滑舌，喜欢挑拨离间' },
  { id:'scholar', label:'学识渊博的博士', desc:'引经据典，逻辑严密' },
  { id:'elder', label:'年迈的老头', desc:'慢悠悠地说话，爱讲道理' },
  { id:'punk', label:'嚣张的鬼火少年', desc:'狂妄自大，说话带火药味' },
  { id:'yuzu', label:'此花亭奇谭中的柚子', desc:'温柔天真，努力为大家服务' },
  { id:'talkative', label:'没完没了的话痨', desc:'滔滔不绝，什么都要说一大堆' },
  { id:'silent', label:'沉默寡言的少年', desc:'惜字如金，只说最关键的话' },
  { id:'chuuni', label:'喜欢看动漫的中二病', desc:'满口中二台词，动不动就发动技能' },
  { id:'custom', label:'✏️ 自定义', desc:'自由输入性格描述' },
];

const MODE_CONFIGS = {
  1: { icon:'🎯', label:'经典8人局（少狼）', desc:'2狼人 + 2神职（预言家、女巫）+ 4平民', roles:['werewolf','werewolf','villager','villager','villager','villager','seer','witch'], wolfCount:2, winRule:'parity', specialRoles:['seer','witch'] },
  2: { icon:'🏹', label:'猎人局（多狼）', desc:'3狼人 + 3神职（预言家、女巫、猎人）+ 2平民', descExtra:'🐺 屠边：狼人杀光平民或神职即可获胜', roles:['werewolf','werewolf','werewolf','villager','villager','hunter','seer','witch'], wolfCount:3, winRule:'edge', specialRoles:['seer','witch','hunter'] },
  3: { icon:'⚡', label:'10人速推局', desc:'3狼人 + 3神职（预言家、女巫、猎人）+ 4平民', roles:['werewolf','werewolf','werewolf','villager','villager','villager','villager','seer','witch','hunter'], wolfCount:3, winRule:'parity', specialRoles:['seer','witch','hunter'] },
  4: { icon:'🏟️', label:'12人标准场（竞技核心）', desc:'4狼人 + 4神职（预言家、女巫、猎人、白痴）+ 4平民', descExtra:'🐺 屠边规则：狼人杀光平民或神职即可获胜', roles:['werewolf','werewolf','werewolf','werewolf','villager','villager','villager','villager','seer','witch','hunter','idiot'], wolfCount:4, winRule:'edge', specialRoles:['seer','witch','hunter','idiot'] },
};

const shuffle = a => { const b=[...a]; for(let i=b.length-1;i>0;i--){const j=0|Math.random()*(i+1);[b[i],b[j]]=[b[j],b[i]];} return b; };

/* ========== API UTILITIES ========== */
async function callPlayerAPI(config, prompt, signal) {
  const res = await fetch(config.apiUrl, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model||'gpt-3.5-turbo', max_tokens: config.maxTokens||65536, messages:[{role:'user',content:prompt}] }),
    signal,
  });
  if(!res.ok) { const e = await res.text().catch(()=>''); throw new Error(`API ${res.status}: ${e.substring(0,200)}`); }
  const data = await res.json();
  if(data.choices?.[0]?.message?.content) return data.choices[0].message.content;
  if(data.content?.[0]?.text) return data.content[0].text;
  if(typeof data.response==='string') return data.response;
  if(data.output?.text) return data.output.text;
  if(data.result) return typeof data.result==='string'?data.result:JSON.stringify(data.result);
  throw new Error('无法解析API响应: '+JSON.stringify(data).substring(0,300));
}

function parsePlainAction(text) {
  // Try ##ACTION:type:target## format
  let m = text.match(/##ACTION:(\w+):?([^#]*)##/);
  if(m) {
    const action=m[1], raw=(m[2]||'').trim();
    if(action==='skip'||action==='sleep') return {action:'skip',target:null};
    if(raw==='abstain') return {action,target:'abstain'};
    const n=parseInt(raw);
    if(!isNaN(n)) return {action,target:n-1}; // 1-indexed→0-indexed
    return {action,target:null};
  }
  return null;
}

function parsePlainSpeech(text) {
  const m=text.match(/##SPEECH:开始##([\s\S]*?)##SPEECH:结束##/);
  return m?m[1].trim():text.replace(/##.*?##/g,'').trim().substring(0,500);
}

/* ========== PLAIN TEXT PROMPT BUILDERS (for API mode, no encryption) ========== */
function buildRulesText(mc, settings) {
  const hl=mc.roles.includes('hunter'), hi=mc.roles.includes('idiot');
  const sL=(mc.specialRoles||[]).map(r=>RM[r]).join('、');
  const vN=mc.roles.filter(r=>r==='villager').length;
  const ww=mc.winRule==='edge'?`所有平民(${vN}名)出局 或 所有神职(${sL})出局→狼人胜`:'存活好人数≤存活狼人数→狼人胜';
  let r=`游戏规则(${mc.roles.length}人·${mc.label}·${mc.desc}):\n- 夜晚：狼人选择击杀，预言家查验，女巫用药\n- 白天：存活玩家依次发言→投票→票最多者出局(平票无人出局)\n- 胜利：狼人全灭→好人胜; ${ww}\n- 女巫第一晚可自救，之后不可; 同一晚不能同时用解药和毒药`;
  if(hl) r+='\n- 猎人死亡时可开枪带走一人（被毒杀除外）';
  if(hi) r+='\n- 白痴被公投可翻牌免死，之后失去投票权但可发言';
  if(settings){
    r+='\n- 死亡后身份：'+(settings.revealDead?'公开':'不公开');
    if(settings.enableLW){
      r+='\n- 遗言：'+(settings.allowNightLW?(settings.onlyFirstNightLW?'白天死亡可发遗言，夜晚仅第一夜可发遗言':'白天和夜晚死亡均可发遗言'):'仅白天投票出局可发遗言');
    }else{
      r+='\n- 遗言：不可发遗言';
    }
    r+='\n- 投票结果：每轮投票后公布各人投票详情';
  }
  return r;
}

function buildAliveDeadStr(ps, revealDead) {
  const a=ps.filter(p=>p.alive), d=ps.filter(p=>!p.alive);
  let s=`\n存活(${a.length}): ${a.map(p=>`${p.id+1}号${p.name}`).join('、')}`;
  if(d.length) s+=`\n出局: ${d.map(p=>`${p.id+1}号${p.name}${revealDead&&p.role?'('+RM[p.role]+')':''}`).join('、')}`;
  return s;
}

function buildHistoryStr(gh) { return gh.length?'\n\n【游戏历史】\n'+gh.join('\n'):''; }

function buildPersonalityStr(p, hardcore, prefix) {
  if(!p.personality) return '';
  const tag = prefix || '性格扮演';
  let s = `\n【${tag}】以「${p.personality}」风格说话。`;
  if(hardcore) s += '简单模仿该角色的语气和说话习惯即可，重点专注于游戏的推理与逻辑分析，不要说与狼人杀无关的废话。';
  return s;
}

function buildSettingsStr(settings) {
  if(!settings) return '';
  let s='\n- 死亡后身份：'+(settings.revealDead?'公开':'不公开');
  if(settings.enableLW){
    s+='\n- 遗言：'+(settings.allowNightLW?(settings.onlyFirstNightLW?'白天死亡可发遗言，夜晚仅第一夜可发遗言':'白天和夜晚死亡均可发遗言'):'仅白天投票出局可发遗言');
  }else{
    s+='\n- 遗言：不可发遗言';
  }
  s+='\n- 投票结果：每轮投票后公布各人投票详情';
  return s;
}

/* ========== FIX: Filter game history per player's perspective ========== */
function filterGameHistoryForPlayer(gh, player, allPlayers) {
  return gh.filter(entry => {
    // [玩家] line exposes all roles — always hide
    if (entry.includes('[玩家]')) return false;
    // Night wolf actions — only wolves can see
    if (entry.includes('[夜晚-狼人]')) return player.role === 'werewolf';
    // Night seer actions — only the seer can see
    if (entry.includes('[夜晚-预言家]')) return player.role === 'seer';
    // Night witch actions — only the witch can see
    if (entry.includes('[夜晚-女巫]')) return player.role === 'witch';
    // Everything else is public: night results, day speeches, votes, last words, hunter shots, round markers
    return true;
  });
}

function plainRolePrompt(p, ps, mc, settings) {
  let ri=`你是${p.id+1}号"${p.name}"，身份：${RM[p.role]}。`;
  if(p.role==='werewolf') ri+=`\n队友: ${ps.filter(q=>q.role==='werewolf'&&q.id!==p.id).map(q=>`${q.id+1}号${q.name}`).join('、')}`;
  if(p.role==='witch') ri+='\n你有一瓶解药和一瓶毒药。';
  if(p.role==='seer') ri+='\n你每晚可查验一名玩家身份(狼人/好人)。';
  if(p.role==='hunter') ri+='\n你死亡时可开枪带走一名玩家(被毒杀除外)。';
  if(p.role==='idiot') ri+='\n被公投出局可翻牌免死，之后失去投票权。';
  let pi=buildPersonalityStr(p,settings?.personalityHardcore,'性格扮演');
  return `你正在参与${ps.length}人狼人杀。\n\n${buildRulesText(mc,settings)}\n\n${ri}${pi}\n\n回复格式：\n- 行动: ##ACTION:类型:目标号## (如 ##ACTION:kill:3## 击杀3号)\n  类型: kill/check/save/poison/vote/shoot/skip\n- 发言: ##SPEECH:开始##内容##SPEECH:结束##\n\n请回复"已理解"(只回三个字)`;
}

function plainWolfPrompt(p, ps, ctx) {
  const mates=ps.filter(q=>q.role==='werewolf'&&q.id!==p.id);
  const targets=ps.filter(q=>q.alive&&q.role!=='werewolf');
  let prev='';
  if(ctx.wolfVotes&&Object.keys(ctx.wolfVotes).length) prev='\n队友已选: '+Object.entries(ctx.wolfVotes).map(([k,v])=>`${ps[k].name}→${ps[v].name}(${+v+1}号)`).join('、');
  let pi=buildPersonalityStr(p,ctx.settings?.personalityHardcore,'性格');
  return `${buildRulesText(ctx.mc,ctx.settings)}\n\n你是${p.id+1}号"${p.name}"，身份：狼人\n队友: ${mates.map(q=>`${q.id+1}号${q.name}(${q.alive?'存活':'出局'})`).join('、')}\n第${ctx.round}轮夜晚${buildAliveDeadStr(ps,ctx.settings?.revealDead)}${pi}${buildHistoryStr(ctx.gh)}${prev}\n\n【任务】选择一名非狼人击杀。\n可选: ${targets.map(q=>`${q.id+1}号${q.name}`).join('、')}\n\n只回复一行:\n##ACTION:kill:目标号##`;
}

function plainSeerPrompt(p, ps, ctx) {
  const targets=ps.filter(q=>q.alive&&q.id!==p.id);
  let hist=''; if(ctx.seerHistory?.length) hist='\n查验记录: '+ctx.seerHistory.map(h=>`${ps[h.target].name}(${h.target+1}号)→${h.isWolf?'狼人':'好人'}`).join('、');
  let pi=buildPersonalityStr(p,ctx.settings?.personalityHardcore,'性格');
  return `${buildRulesText(ctx.mc,ctx.settings)}\n\n你是${p.id+1}号"${p.name}"，身份：预言家\n第${ctx.round}轮夜晚${buildAliveDeadStr(ps,ctx.settings?.revealDead)}${hist}${pi}${buildHistoryStr(ctx.gh)}\n\n【任务】选择一名存活玩家查验。\n可选: ${targets.map(q=>`${q.id+1}号${q.name}`).join('、')}\n\n只回复一行:\n##ACTION:check:目标号##`;
}

function plainWitchPrompt(p, ps, ctx) {
  const nk=ctx.nightKill, self=nk===p.id;
  const canSave=ctx.witchSave&&nk!==null&&(ctx.round===1||!self);
  const others=ps.filter(q=>q.alive&&q.id!==p.id);
  let opts=[];
  if(canSave) opts.push(`救人: ##ACTION:save:${nk+1}##`);
  if(ctx.witchPoison) opts.push(`毒杀: ##ACTION:poison:目标号## (可选: ${others.map(q=>`${q.id+1}号${q.name}`).join('、')})`);
  opts.push('不行动: ##ACTION:skip##');
  let pi=buildPersonalityStr(p,ctx.settings?.personalityHardcore,'性格');
  return `${buildRulesText(ctx.mc,ctx.settings)}\n\n你是${p.id+1}号"${p.name}"，身份：女巫\n第${ctx.round}轮夜晚${buildAliveDeadStr(ps,ctx.settings?.revealDead)}\n被杀: ${nk!==null?`${ps[nk].name}(${nk+1}号)`:'无'}\n解药: ${ctx.witchSave?'可用':'已用'}${canSave?'':'(不可自救)'} | 毒药: ${ctx.witchPoison?'可用':'已用'}\n注意: 同一晚不能同时用解药和毒药${pi}${buildHistoryStr(ctx.gh)}\n\n【任务】选择行动:\n${opts.join('\n')}\n\n只回复一行:`;
}

function plainSpeechPrompt(p, ps, ctx) {
  let ri=`你是${p.id+1}号"${p.name}"，身份：${RM[p.role]}`;
  if(p.role==='werewolf') { ri+=`\n队友: ${ps.filter(q=>q.role==='werewolf'&&q.id!==p.id).map(q=>`${q.id+1}号${q.name}(${q.alive?'存活':'出局'})`).join('、')}\n注意：隐藏狼人身份，不暴露队友。`; }
  if(p.role==='seer'&&ctx.seerHistory?.length) ri+='\n查验记录: '+ctx.seerHistory.map(h=>`${ps[h.target].name}(${h.target+1}号)→${h.isWolf?'狼人':'好人'}`).join('、');
  const sp=ctx.speeches||[];
  let spStr=''; if(sp.length) spStr='\n\n--- 已有发言 ---\n'+sp.map(s=>`${s.name}(${s.id+1}号): ${s.text}`).join('\n')+'\n---';
  let pi=buildPersonalityStr(p,ctx.settings?.personalityHardcore,'性格扮演');
  let wl=''; if(ctx.wordLimit) wl=`\n【字数】${ctx.wordLimit}字${ctx.wordMode==='min'?'以上':'以内'}。`;
  return `${buildRulesText(ctx.mc,ctx.settings)}\n\n${ri}\n第${ctx.round}轮白天${buildAliveDeadStr(ps,ctx.settings?.revealDead)}\n昨晚: ${ctx.nightResult||'未知'}${pi}${wl}${buildHistoryStr(ctx.gh)}${spStr}\n\n【任务】请发言。\n##SPEECH:开始##\n你的发言\n##SPEECH:结束##`;
}

function plainVotePrompt(p, ps, ctx) {
  let ri=`你是${p.id+1}号"${p.name}"，身份：${RM[p.role]}`;
  if(p.role==='werewolf') ri+=`\n队友: ${ps.filter(q=>q.role==='werewolf'&&q.id!==p.id).map(q=>`${q.id+1}号${q.name}(${q.alive?'存活':'出局'})`).join('、')}`;
  if(p.role==='seer'&&ctx.seerHistory?.length) ri+='\n查验记录: '+ctx.seerHistory.map(h=>`${ps[h.target].name}(${h.target+1}号)→${h.isWolf?'狼人':'好人'}`).join('、');
  const sp=ctx.speeches||[];
  let spStr=''; if(sp.length) spStr='\n\n--- 发言 ---\n'+sp.map(s=>`${s.name}(${s.id+1}号): ${s.text}`).join('\n')+'\n---';
  const others=ps.filter(q=>q.alive&&q.id!==p.id);
  return `${buildRulesText(ctx.mc,ctx.settings)}\n\n${ri}\n第${ctx.round}轮投票${buildAliveDeadStr(ps,ctx.settings?.revealDead)}\n昨晚: ${ctx.nightResult||'未知'}${buildHistoryStr(ctx.gh)}${spStr}\n\n【任务】投票或弃票。\n可选: ${others.map(q=>`${q.id+1}号${q.name}`).join('、')}\n\n回复一行:\n##ACTION:vote:目标号## 或 ##ACTION:vote:abstain##`;
}

function plainHunterPrompt(p, ps, ctx) {
  const others=ps.filter(q=>q.alive&&q.id!==p.id);
  return `你是${p.id+1}号"${p.name}"，身份：猎人。你已死亡，可开枪带走一人。${buildAliveDeadStr(ps,ctx.settings?.revealDead)}${buildHistoryStr(ctx.gh)}\n可选: ${others.map(q=>`${q.id+1}号${q.name}`).join('、')}\n\n回复一行:\n##ACTION:shoot:目标号## 或 ##ACTION:skip##`;
}

function plainLastWordsPrompt(p, ps, ctx) {
  let pi=buildPersonalityStr(p,ctx.settings?.personalityHardcore,'性格');
  let wl='';if(ctx.wordLimit)wl=`\n【字数】${ctx.wordLimit}字${ctx.wordMode==='min'?'以上':'以内'}。`;
  return `你是${p.id+1}号"${p.name}"，身份：${RM[p.role]}。你已出局，请发遗言。${pi}${wl}${buildHistoryStr(ctx.gh)}\n\n##SPEECH:开始##\n你的遗言\n##SPEECH:结束##`;
}

/* ========== ENCRYPTED PROMPT BUILDERS (for manual mode) ========== */
const genCodes=(n)=>{const C='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',rc=()=>C[0|Math.random()*C.length];const base=Array.from({length:8},rc).join('');const s=new Set([base]);let att=0;while(s.size<n&&att<5000){const a=base.split('');const c=Math.random()>0.4?2:1;for(let i=0;i<c;i++)a[0|Math.random()*a.length]=rc();s.add(a.join(''));att++;}return shuffle([...s]);};
const genEnc=(seatCount=8)=>{const c=genCodes(128),s=shuffle(c);let idx=0;const next=()=>s[idx++];return{roles:{werewolf:next(),villager:next(),seer:next(),witch:next(),hunter:next(),idiot:next()},seats:Array.from({length:seatCount},()=>next()),acts:{kill:next(),check:next(),save:next(),poison:next(),vote:next(),skip:next(),sleep:next(),shoot:next()},res:{isWolf:next(),isGood:next()},inst:{wolfKill:next(),wolfNoSelf:next(),wolfMate:next(),wolfPrev:next(),seerCheck:next(),seerPrev:next(),witchInfo:next(),witchSaveAvail:next(),witchSaveUsed:next(),witchPoiAvail:next(),witchPoiUsed:next(),witchNoSelf:next(),sleepWait:next(),phaseTag:next(),noAction:next(),roundTag:next(),targetHint:next(),padLine1:next(),padLine2:next(),padLine3:next(),padLine4:next(),padLine5:next(),padLine6:next(),padData1:next(),padData2:next(),padData3:next(),padData4:next(),padData5:next(),seerLastNight:next(),hunterShoot:next(),hunterDeath:next()},noise:s.slice(idx)};};

const makeTable=(enc)=>{const hh=enc.hasHunter,hi=enc.hasIdiot;const bp=[`${enc.noise[0]}=校验码A`,`${enc.roles.villager}=平民`,`${enc.noise[1]}=校验码B`,`${enc.roles.werewolf}=狼人`,`${enc.noise[2]}=校验码C`,`${enc.roles.seer}=预言家`,`${enc.noise[3]}=校验码D`,`${enc.roles.witch}=女巫`,`${enc.noise[4]}=校验码E`];if(hh)bp.push(`${enc.roles.hunter}=猎人`);if(hi)bp.push(`${enc.roles.idiot}=白痴`);bp.push(`${enc.noise[5]}=校验码F`);const pairs=shuffle(bp);const sp=enc.seats.map((c,i)=>`${c}=${i+1}号`);const ba=[`${enc.acts.kill}=击杀`,`${enc.acts.check}=查验`,`${enc.acts.save}=解救`,`${enc.acts.poison}=毒杀`,`${enc.acts.vote}=投票`,`${enc.acts.skip}=不行动`,`${enc.acts.sleep}=等待天亮`,`${enc.noise[6]}=确认码G`,`${enc.noise[7]}=确认码H`];if(hh)ba.push(`${enc.acts.shoot}=猎人开枪`);const ap=shuffle(ba);const rp=shuffle([`${enc.res.isWolf}=查验结果:狼人`,`${enc.res.isGood}=查验结果:好人`,`${enc.noise[8]}=验证码I`,`${enc.noise[9]}=验证码J`]);const bi=[`${enc.inst.wolfKill}=指令:选择击杀目标`,`${enc.inst.wolfNoSelf}=指令:不可选择同阵营`,`${enc.inst.wolfMate}=指令:同阵营成员`,`${enc.inst.wolfPrev}=指令:已有成员选择`,`${enc.inst.seerCheck}=指令:选择查验目标`,`${enc.inst.seerPrev}=指令:历史查验记录`,`${enc.inst.witchInfo}=指令:本轮被击杀者`,`${enc.inst.witchSaveAvail}=指令:解药状态可用`,`${enc.inst.witchSaveUsed}=指令:解药状态已用`,`${enc.inst.witchPoiAvail}=指令:毒药状态可用`,`${enc.inst.witchPoiUsed}=指令:毒药状态已用`,`${enc.inst.witchNoSelf}=指令:本轮不可对自身使用`,`${enc.inst.sleepWait}=指令:本阶段无需行动等待`,`${enc.inst.phaseTag}=标记:行动阶段`,`${enc.inst.noAction}=指令:不执行行动`,`${enc.inst.roundTag}=标记:当前轮次`,`${enc.inst.targetHint}=指令:请填入座位密钥`,`${enc.inst.padLine1}=校验指令P1`,`${enc.inst.padLine2}=校验指令P2`,`${enc.inst.padLine3}=校验指令P3`,`${enc.inst.padLine4}=校验指令P4`,`${enc.inst.padLine5}=校验指令P5`,`${enc.inst.padLine6}=校验指令P6`,`${enc.inst.padData1}=校验数据D1`,`${enc.inst.padData2}=校验数据D2`,`${enc.inst.padData3}=校验数据D3`,`${enc.inst.padData4}=校验数据D4`,`${enc.inst.padData5}=校验数据D5`,`${enc.inst.seerLastNight}=指令:昨晚查验结果`,`${enc.noise[10]}=校验指令X`,`${enc.noise[11]}=校验指令Y`];if(hh){bi.push(`${enc.inst.hunterShoot}=指令:猎人开枪选择目标`);bi.push(`${enc.inst.hunterDeath}=指令:猎人死亡触发技能`);}const ip=shuffle(bi);return `━━━ 加密对照表 ━━━\n[身份] ${pairs.join(' | ')}\n[座位] ${sp.join(' | ')}\n[行动] ${ap.join(' | ')}\n[结果] ${rp.join(' | ')}\n[指令] ${ip.join(' | ')}\n━━━━━━━━━━━━━━━━━━`;};

function buildPublicInfoBlock(players,ctx){let l=[];const ri=players.filter(p=>p.idiotRevealed);if(ri.length)l.push(`[已翻牌] ${ri.map(p=>`${p.name}(${p.id+1}号)=白痴`).join(', ')}`);if(ctx.revealDeadIdentity){const d=players.filter(p=>!p.alive);if(d.length)l.push(`[已公布身份] ${d.map(p=>`${p.name}(${p.id+1}号)=${RM[p.role]}`).join(', ')}`);}if(ctx.voteHistory?.length)for(const vh of ctx.voteHistory)l.push(`[第${vh.round}轮投票] ${vh.details}`);if(ctx.lastWords?.length)for(const lw of ctx.lastWords)l.push(`[遗言] ${players[lw.playerId].name}: ${lw.text}`);return l.length?'\n'+l.join('\n'):'';}

function makeRolePrompt(enc,p,ps,mc,settings){const t=makeTable(enc),rc=enc.roles[p.role],sc=enc.seats[p.id];let ex='';if(p.role==='werewolf'){ex=`\n◆ ${enc.inst.wolfMate}: ${ps.filter(q=>q.role==='werewolf'&&q.id!==p.id).map(q=>enc.seats[q.id]).join(', ')}`;}if(p.role==='witch')ex=`\n◆ ${enc.inst.witchSaveAvail} | ${enc.inst.witchPoiAvail}`;if(p.role==='seer')ex=`\n◆ ${enc.inst.seerCheck}`;if(p.role==='hunter')ex=`\n◆ ${enc.inst.hunterShoot}: ${enc.inst.hunterDeath}`;if(p.role==='villager')ex=`\n◆ ${enc.inst.padLine1}: ${enc.inst.padData1}`;if(p.role==='idiot')ex=`\n◆ 白痴特性: 公投免死`;const sL=(mc.specialRoles||[]).map(r=>RM[r]).join('、');const vN=mc.roles.filter(r=>r==='villager').length;const hH=mc.roles.includes('hunter'),hI=mc.roles.includes('idiot');const ww=mc.winRule==='edge'?`所有平民(${vN}名)出局或所有神职(${sL})出局→狼人胜`:'存活好人数≤狼人数→狼人胜';const ss=buildSettingsStr(settings);return `你正在参与${ps.length}人狼人杀（${mc.label}），系统裁判。\n请阅读加密对照表。\n\n${t}\n\n◆ 座位密钥: ${sc}\n◆ 身份密钥: ${rc}${ex}\n\n规则:\n- 夜晚行动，白天讨论投票\n- 胜利：狼全灭→好人胜;${ww}\n- 女巫第一晚可自救，之后不可;同晚不能同时用解药和毒药\n${hH?'- 猎人死亡可开枪(毒杀除外)\n':''}${hI?'- 白痴公投免死，失去投票权\n':''}${ss}\n行动格式: ##ACTION:行动密钥:目标座位密钥##\n等待: ##ACTION:${enc.acts.sleep}:${enc.acts.sleep}##\n发言: ##SPEECH:开始##内容##SPEECH:结束##\n${p.personality?`\n【性格扮演】以「${p.personality}」风格对话。\n`:''}\n回复"已理解"(只三个字)`;}

function makeNightWolf(enc,p,ps,ctx){const t=makeTable(enc);const alive=ps.filter(q=>q.alive),dead=ps.filter(q=>!q.alive);const as=alive.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', '),ds=dead.length?dead.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', '):'—';const mates=ps.filter(q=>q.role==='werewolf'&&q.id!==p.id&&q.alive).map(q=>enc.seats[q.id]).join(',');const pv=ctx.wolfVotes||{};let pvs=enc.inst.padData3;if(Object.keys(pv).length)pvs=Object.entries(pv).map(([k,v])=>`${enc.seats[k]}→${enc.seats[v]}`).join(', ');const pub=buildPublicInfoBlock(ps,ctx);return `${t}\n\n◆ ${enc.seats[p.id]} | ${enc.roles[p.role]}\n◆ ${enc.inst.roundTag} ${ctx.round} | ${as} | ${ds}\n\n${enc.inst.phaseTag} 1/3\n${enc.inst.wolfMate}: ${mates}\n${enc.inst.wolfPrev}: ${pvs}\n${enc.inst.wolfKill} [${enc.inst.wolfNoSelf}]\n${enc.inst.padLine3}: ${enc.inst.padData1}\n${enc.inst.padLine4}: ${enc.inst.padData2}${pub}\n→ ##ACTION:${enc.acts.kill}:${enc.inst.targetHint}##`;}

function makeNightSeer(enc,p,ps,ctx){const t=makeTable(enc);const alive=ps.filter(q=>q.alive),dead=ps.filter(q=>!q.alive);const as=alive.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', '),ds=dead.length?dead.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', '):'—';let hist=enc.inst.padData3;if(ctx.seerHistory?.length)hist=ctx.seerHistory.map(h=>`${enc.seats[h.target]}→${h.isWolf?enc.res.isWolf:enc.res.isGood}`).join(', ');const pub=buildPublicInfoBlock(ps,ctx);return `${t}\n\n◆ ${enc.seats[p.id]} | ${enc.roles[p.role]}\n◆ ${enc.inst.roundTag} ${ctx.round} | ${as} | ${ds}\n\n${enc.inst.phaseTag} 2/3\n${enc.inst.seerCheck}: ${enc.inst.padData1}\n${enc.inst.seerPrev}: ${hist}\n${enc.inst.padLine1}: ${enc.inst.padData2}${pub}\n→ ##ACTION:${enc.acts.check}:${enc.inst.targetHint}##`;}

function makeNightWitch(enc,p,ps,ctx){const t=makeTable(enc);const alive=ps.filter(q=>q.alive),dead=ps.filter(q=>!q.alive);const as=alive.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', '),ds=dead.length?dead.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', '):'—';const kt=ctx.nightKill!==null?enc.seats[ctx.nightKill]:enc.inst.padData1;const self=ctx.nightKill===p.id,canS=ctx.witchHasSave&&ctx.nightKill!==null&&(ctx.round===1||!self);const ss=ctx.witchHasSave?enc.inst.witchSaveAvail+(canS?'':`[${enc.inst.witchNoSelf}]`):enc.inst.witchSaveUsed;const ps2=ctx.witchHasPoison?enc.inst.witchPoiAvail:enc.inst.witchPoiUsed;let al;if(canS&&ctx.witchHasPoison)al=`→ ##ACTION:${enc.acts.save}:${enc.seats[ctx.nightKill]}## | ##ACTION:${enc.acts.poison}:${enc.inst.targetHint}## | ##ACTION:${enc.acts.skip}:${enc.acts.skip}##`;else if(canS)al=`→ ##ACTION:${enc.acts.save}:${enc.seats[ctx.nightKill]}## | ##ACTION:${enc.acts.skip}:${enc.acts.skip}##`;else if(ctx.witchHasPoison)al=`→ ##ACTION:${enc.acts.poison}:${enc.inst.targetHint}## | ##ACTION:${enc.acts.skip}:${enc.acts.skip}##`;else al=`→ ##ACTION:${enc.acts.skip}:${enc.acts.skip}##`;const pub=buildPublicInfoBlock(ps,ctx);return `${t}\n\n◆ ${enc.seats[p.id]} | ${enc.roles[p.role]}\n◆ ${enc.inst.roundTag} ${ctx.round} | ${as} | ${ds}\n\n${enc.inst.phaseTag} 3/3\n${enc.inst.witchInfo}: ${kt}\n${ss}\n${ps2}\n${enc.inst.padLine1}: ${enc.inst.padData2}\n${enc.inst.noAction}: ${enc.inst.padData4}${pub}\n${al}`;}

function makeNightSleep(enc,p,ps,ctx,si){const t=makeTable(enc);const alive=ps.filter(q=>q.alive),dead=ps.filter(q=>!q.alive);const as=alive.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', '),ds=dead.length?dead.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', '):'—';const pub=buildPublicInfoBlock(ps,ctx);return `${t}\n\n◆ ${enc.seats[p.id]} | ${enc.roles[p.role]}\n◆ ${enc.inst.roundTag} ${ctx.round} | ${as} | ${ds}\n\n${enc.inst.phaseTag} ${si}/3\n${enc.inst.sleepWait}: ${enc.inst.padData1}\n${enc.inst.padLine1}: ${enc.inst.padData2}${pub}\n→ ##ACTION:${enc.acts.sleep}:${enc.acts.sleep}##`;}

function makeHunterShootPrompt(enc,p,ps,ctx){const t=makeTable(enc);const alive=ps.filter(q=>q.alive&&q.id!==p.id).map(q=>`${enc.seats[q.id]}(${q.name})`).join(', ');return `${t}\n\n◆ ${enc.seats[p.id]} | ${enc.roles[p.role]}\n◆ ${enc.inst.roundTag} ${ctx.round}\n◆ ${enc.inst.hunterDeath}\n◆ ${enc.inst.hunterShoot}: ${alive}\n→ ##ACTION:${enc.acts.shoot}:${enc.inst.targetHint}## | ##ACTION:${enc.acts.skip}:${enc.acts.skip}##`;}

function makeLastWordsPrompt(enc,p,ps,ctx){const t=makeTable(enc);return `${t}\n\n◆ ${enc.seats[p.id]} | ${enc.roles[p.role]}\n◆ ${enc.inst.roundTag} ${ctx.round}\n\n你已出局，请发遗言。\n##SPEECH:开始##\n\n##SPEECH:结束##`;}

function makeDayPrompt(enc,p,ps,ctx,type){const t=makeTable(enc);const alive=ps.filter(q=>q.alive),dead=ps.filter(q=>!q.alive);const as=alive.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', '),ds=dead.map(q=>`${enc.seats[q.id]}(${q.name})`).join(', ')||'无';let si='';if(p.role==='seer'&&ctx.seerHistory?.length){const lc=ctx.seerHistory[ctx.seerHistory.length-1];si=`\n[${enc.inst.seerLastNight}] ${enc.seats[lc.target]}→${lc.isWolf?enc.res.isWolf:enc.res.isGood}`;si+=`\n[${enc.inst.seerPrev}] `+ctx.seerHistory.map(h=>`${enc.seats[h.target]}→${h.isWolf?enc.res.isWolf:enc.res.isGood}`).join(' | ');}let wi='';if(p.role==='werewolf'){wi=`\n[${enc.inst.wolfMate}] `+ps.filter(q=>q.role==='werewolf'&&q.id!==p.id).map(q=>`${enc.seats[q.id]}(${q.alive?'存活':'出局'})`).join(', ');}if(!si&&!wi)si=`\n[${enc.inst.padLine6}] ${enc.inst.padData1}`;const nr=ctx.nightResult||'';const sp=ctx.speeches||[];const spStr=sp.length?'\n--- 已有发言 ---\n'+sp.map(s=>`${s.name}(${enc.seats[s.id]}): ${s.text}`).join('\n')+'\n---':'';const pub=buildPublicInfoBlock(ps,ctx);const ss=buildSettingsStr(ctx.settings);let wl='';if(ctx.wordLimitEnabled&&ctx.wordLimitNum>0)wl=`\n\n【字数】${ctx.wordLimitNum}字${ctx.wordLimitMode==='min'?'以上':'以内'}。`;if(type==='speech')return `${t}\n\n◆ ${enc.seats[p.id]} | ${enc.roles[p.role]}\n◆ ${enc.inst.roundTag} ${ctx.round} | ${as} | ${ds}\n${nr}${si}${wi}${pub}${ss}${spStr}${wl}\n\n##SPEECH:开始##\n\n##SPEECH:结束##`;else return `${t}\n\n◆ ${enc.seats[p.id]} | ${enc.roles[p.role]}\n◆ ${enc.inst.roundTag} ${ctx.round} | ${as} | ${ds}\n${nr}${si}${wi}${pub}${ss}${spStr}\n\n→ ##ACTION:${enc.acts.vote}:${enc.inst.targetHint}## | ##ACTION:${enc.acts.skip}:${enc.acts.skip}##(弃票)`;}

function parseAction(text,enc){const m=text.match(/##ACTION:(\S+?):(\S+?)##/);if(!m)return null;const[,ac,tc]=m;let a=Object.entries(enc.acts).find(([,v])=>v===ac);a=a?a[0]:null;if(a==='sleep')return{action:'sleep',target:null};if(ac===enc.acts.skip||tc===enc.acts.skip)return{action:'skip',target:null};let tg=enc.seats.indexOf(tc);if(tg===-1)tg=null;return{action:a,target:tg};}
function parseSpeech(text){const m=text.match(/##SPEECH:开始##([\s\S]*?)##SPEECH:结束##/);return m?m[1].trim():text.replace(/##.*?##/g,'').trim().substring(0,500);}

const initPlayers=(n=8,prev=[])=>Array.from({length:n},(_,i)=>{const p=prev[i];return{id:i,name:p?.name??`玩家${i+1}`,avatar:(p?.avatar??i)%AVATARS.length,isHuman:p?.isHuman??(i===0),role:null,alive:true,personality:p?.personality??null,canVote:true,idiotRevealed:false};});
const syncPlayersCount=(prev,n)=>{const next=initPlayers(n,prev);for(let i=0;i<Math.min(prev.length,next.length);i++){next[i].isHuman=prev[i].isHuman;next[i].personality=prev[i].personality??null;next[i].avatar=(prev[i].avatar??next[i].avatar)%AVATARS.length;next[i].name=prev[i].name??next[i].name;}return next.map((p,i)=>({...p,id:i}));};

/* ========== MAIN COMPONENT ========== */
const STORAGE_KEY_CLIENT = 'ww_online_client_v1';

function makeClientId() {
  return 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function loadClientIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CLIENT);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.sessionId) {
        return {
          sessionId: String(parsed.sessionId),
          displayName: String(parsed.displayName || '玩家').slice(0, 24) || '玩家',
        };
      }
    }
  } catch (e) {}
  const next = { sessionId: makeClientId(), displayName: '玩家' };
  try { localStorage.setItem(STORAGE_KEY_CLIENT, JSON.stringify(next)); } catch (e) {}
  return next;
}

function saveClientIdentity(next) {
  try { localStorage.setItem(STORAGE_KEY_CLIENT, JSON.stringify(next)); } catch (e) {}
}

function phaseLabel(viewer) {
  if (!viewer) return '大厅';
  if (viewer.phase === 'night') return '🌙 夜晚';
  if (viewer.phase === 'day') return '☀️ 白天';
  if (viewer.phase === 'dayResult') return '📊 结算';
  if (viewer.phase === 'roleReveal') return '🃏 发牌';
  if (viewer.phase === 'lastWords') return '📜 遗言';
  if (viewer.phase === 'hunterShot') return '🏹 猎人技能';
  if (viewer.phase === 'gameOver') return '🏁 结束';
  return '大厅';
}

function HornButton({ count, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-xs px-2.5 py-1.5 rounded-lg border font-bold transition ${disabled ? 'bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed' : 'bg-amber-900/60 border-amber-500 text-amber-300 hover:bg-amber-800/70'}`}
      title="给所有仍在等待中的AI请求发送加速副本，最快者胜出并中断同提示词其他副本"
    >
      📣 加速{count > 0 ? `×${count}` : ''}
    </button>
  );
}

function SeatBadge({ seat, occupiedName, occupied, me }) {
  return (
    <div className={`px-2 py-1 rounded text-xs border ${me ? 'bg-cyan-900/50 border-cyan-500 text-cyan-300' : occupied ? 'bg-gray-800 border-gray-600 text-gray-300' : 'bg-gray-900 border-gray-700 text-gray-500'}`}>
      {seat + 1}号位{me ? '（你）' : occupiedName ? ` · ${occupiedName}` : occupied ? ' · 已占用' : ' · 空位'}
    </div>
  );
}

function RemoteLobbyView({ roomState, client, onUpdateName, onClaimSeat, onReleaseSeat, onLeaveRoom, onRefreshRooms }) {
  const summary = roomState.latestStateSummary || {};
  const players = summary.players || [];
  const mySeat = roomState.mySeat;
  const availableSeats = roomState.availableSeats || [];
  const [nameInput, setNameInput] = useState(client.displayName || '玩家');

  return (
    <div className="min-h-screen bg-gray-950 text-white p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-bold">🐺 联机房间 {roomState.id}</h1>
            <p className="text-sm text-gray-400 mt-1">{roomState.isPrivate ? '🔒 私人房间' : '🌐 公开房间'} · 房主：{roomState.members?.find(m => m.isHost)?.displayName || '房主'} · {summary.gameLabel || '等待配置'}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={onRefreshRooms} className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-2 rounded-lg">刷新列表</button>
            <button onClick={onLeaveRoom} className="text-xs bg-gray-800 hover:bg-red-800 border border-gray-700 px-3 py-2 rounded-lg">离开房间</button>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-cyan-300 mb-3">👤 你的联机身份</h2>
            <div className="flex gap-2 mb-3">
              <input
                value={nameInput}
                onChange={e => setNameInput(e.target.value.slice(0, 24))}
                className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm"
                placeholder="你的联机昵称"
              />
              <button onClick={() => onUpdateName(nameInput || '玩家')} className="bg-cyan-700 hover:bg-cyan-600 text-white text-sm px-4 py-2 rounded-lg">保存</button>
            </div>
            <div className="space-y-2 text-sm">
              <div className="text-gray-300">当前昵称：<span className="text-cyan-300 font-bold">{client.displayName}</span></div>
              <div className="text-gray-300">当前席位：{mySeat !== null && mySeat !== undefined ? <span className="text-yellow-300 font-bold">{mySeat + 1}号位</span> : <span className="text-gray-500">未入座（旁观中）</span>}</div>
            </div>
            {mySeat !== null && mySeat !== undefined && mySeat !== 0 && (
              <button onClick={onReleaseSeat} className="mt-3 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-2 rounded-lg w-full">释放当前席位</button>
            )}
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-yellow-300 mb-3">🪑 可加入的人类席位</h2>
            <div className="flex flex-wrap gap-2 mb-3">
              {availableSeats.length > 0 ? availableSeats.map(seat => (
                <button
                  key={seat.id}
                  onClick={() => onClaimSeat(seat.id)}
                  disabled={!!seat.occupiedBy && roomState.mySeat !== seat.id}
                  className={`px-3 py-2 rounded-lg text-sm border ${roomState.mySeat === seat.id ? 'bg-cyan-900/60 border-cyan-500 text-cyan-300' : seat.occupiedBy ? 'bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-950 border-gray-700 text-gray-200 hover:border-yellow-500'}`}
                >
                  {seat.id + 1}号位 {seat.isHostSeat ? '👑' : ''}
                </button>
              )) : <p className="text-sm text-gray-500">当前没有开放的人类席位，请等待房主配置。</p>}
            </div>
            <div className="text-xs text-gray-500">房主固定为1号位。其他玩家只能加入被房主切换为“人类”的席位。</div>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1.3fr_1fr] gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-gray-200 mb-3">🎮 房主当前配置</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {players.map(p => (
                <div key={p.id} className={`rounded-xl border p-3 ${p.isHuman ? 'border-cyan-700/50 bg-cyan-950/20' : 'border-gray-800 bg-gray-950/40'}`}>
                  <div className="text-3xl mb-1">{AVATARS[p.avatar]}</div>
                  <div className="text-xs text-gray-500">{p.id + 1}号</div>
                  <div className="text-sm font-bold truncate">{p.name}</div>
                  <div className={`text-xs mt-1 ${p.isHuman ? 'text-cyan-400' : 'text-green-400'}`}>{p.isHuman ? '人类席位' : 'AI席位'}</div>
                  <div className="mt-2"><SeatBadge seat={p.id} occupiedName={p.occupiedName} occupied={p.occupied} me={roomState.mySeat === p.id} /></div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-gray-200 mb-3">🧾 房间概览</h2>
            <div className="space-y-2 text-sm text-gray-300">
              <div>模式：<span className="text-yellow-300">{summary.gameLabel || '等待房主选择'}</span></div>
              <div>API自动：<span className={summary.apiAutoMode ? 'text-cyan-300' : 'text-gray-500'}>{summary.apiAutoMode ? '开启' : '关闭'}</span></div>
              <div>管理员模式：<span className={summary.adminMode ? 'text-red-300' : 'text-gray-500'}>{summary.adminMode ? '开启' : '关闭'}</span></div>
              <div>已加入成员：{(roomState.members || []).length}</div>
            </div>
            <div className="mt-4 border-t border-gray-800 pt-3">
              <h3 className="text-xs font-bold text-gray-500 mb-2">在线成员</h3>
              <div className="space-y-2">
                {(roomState.members || []).map(member => (
                  <div key={member.sessionId} className="flex items-center justify-between text-sm bg-gray-950/60 rounded-lg px-3 py-2 border border-gray-800">
                    <span className="truncate">{member.displayName}{member.isHost ? ' 👑' : ''}</span>
                    <span className="text-xs text-gray-500">{member.seatId !== null && member.seatId !== undefined ? `${member.seatId + 1}号位` : '旁观'}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-4 text-xs text-amber-400">等待房主点击“开始游戏”后，你的界面会自动切换到对局页面。</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RemotePlayerView({ roomState, onAction, onHorn, onLeaveRoom }) {
  const viewer = roomState.viewer || {};
  const mySeat = viewer.mySeat;
  const myPlayer = mySeat !== null && mySeat !== undefined ? viewer.players?.[mySeat] : null;
  const roleInfo = viewer.privateRoleInfo || null;
  const action = viewer.action || null;
  const [speechText, setSpeechText] = useState('');
  const [voteTarget, setVoteTarget] = useState(null);
  const [lastWordsText, setLastWordsText] = useState('');

  useEffect(() => {
    setVoteTarget(null);
    if (!action || !['speech', 'lastWords'].includes(action.type)) {
      setSpeechText('');
      setLastWordsText('');
    }
  }, [action?.type, viewer.round, viewer.phase, viewer.step]);

  const submitAction = payload => {
    if (mySeat === null || mySeat === undefined) return;
    onAction({ ...payload, seatId: mySeat });
  };

  const renderActionCard = () => {
    if (!myPlayer) {
      return <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800 text-sm text-gray-500">你当前处于旁观模式。</div>;
    }
    if (viewer.gameResult) {
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800 text-center">
          <div className="text-5xl mb-3">{viewer.gameResult === 'good' ? '🎉' : '🐺'}</div>
          <div className="text-xl font-bold text-yellow-300">{viewer.gameResult === 'good' ? '好人阵营胜利！' : '狼人阵营胜利！'}</div>
        </div>
      );
    }
    if (!action) {
      return <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800 text-sm text-gray-500">等待房主推进流程…</div>;
    }
    if (action.type === 'roleReveal') {
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-yellow-700/60 text-center">
          <div className="text-5xl mb-3">🃏</div>
          <div className="text-sm text-gray-500 mb-1">你的身份</div>
          <div className="text-2xl font-bold text-yellow-300 mb-2">{roleInfo?.roleLabel || '未知'}</div>
          {roleInfo?.role === 'werewolf' && roleInfo.wolfMates?.length > 0 && (
            <div className="text-sm text-red-300 mb-3">队友：{roleInfo.wolfMates.map(m => `${m.name}(${m.id + 1}号)`).join('、')}</div>
          )}
          <button onClick={() => submitAction({ kind: 'roleRevealConfirm' })} className="bg-yellow-600 hover:bg-yellow-500 text-black font-bold px-6 py-3 rounded-xl w-full">确认身份</button>
        </div>
      );
    }
    if (action.type === 'seerResult') {
      const target = viewer.players?.[action.target];
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-purple-700/60 text-center">
          <div className="text-5xl mb-3">🔮</div>
          <div className="text-sm text-gray-500 mb-1">查验结果</div>
          <div className="text-lg font-bold mb-2">{target ? `${target.name}（${target.id + 1}号）` : '目标'}</div>
          <div className={`inline-flex px-4 py-2 rounded-xl font-bold text-lg ${action.isWolf ? 'bg-red-900/60 text-red-300' : 'bg-green-900/60 text-green-300'}`}>{action.isWolf ? '🐺 狼人' : '✨ 好人'}</div>
          <button onClick={() => submitAction({ kind: 'seerResultConfirm' })} className="mt-4 bg-purple-600 hover:bg-purple-500 text-white font-bold px-6 py-3 rounded-xl w-full">确认</button>
        </div>
      );
    }
    if (action.type === 'nightWolf') {
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-red-700/60">
          <div className="text-xl font-bold text-red-300 mb-3">🐺 今晚请选择击杀目标</div>
          <div className="flex flex-wrap gap-2 mb-4">{(action.targets || []).map(t => <button key={t.id} onClick={() => submitAction({ kind: 'nightSubmit', value: t.id })} className="px-3 py-2 rounded-lg bg-red-900/40 border border-red-700/50 hover:bg-red-800/60 text-sm">{AVATARS[t.avatar]} {t.name}({t.id + 1}号)</button>)}</div>
          <div className="text-xs text-red-400">点击即提交。本房间支持“📣 加速”对仍在生成中的AI发言进行竞速。</div>
        </div>
      );
    }
    if (action.type === 'nightSeer') {
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-purple-700/60">
          <div className="text-xl font-bold text-purple-300 mb-3">🔮 今晚请选择查验目标</div>
          {roleInfo?.seerHistory?.length > 0 && <div className="text-xs text-gray-500 mb-3">历史：{roleInfo.seerHistory.map(h => `${h.target + 1}号→${h.isWolf ? '狼人' : '好人'}`).join('、')}</div>}
          <div className="flex flex-wrap gap-2">{(action.targets || []).map(t => <button key={t.id} onClick={() => submitAction({ kind: 'nightSubmit', value: t.id })} className="px-3 py-2 rounded-lg bg-purple-900/40 border border-purple-700/50 hover:bg-purple-800/60 text-sm">{AVATARS[t.avatar]} {t.name}({t.id + 1}号)</button>)}</div>
        </div>
      );
    }
    if (action.type === 'nightWitch') {
      const killTarget = action.killTarget !== null && action.killTarget !== undefined ? viewer.players?.[action.killTarget] : null;
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-teal-700/60">
          <div className="text-xl font-bold text-teal-300 mb-3">🧪 女巫行动</div>
          <div className="text-sm text-gray-300 mb-3">被杀目标：{killTarget ? `${killTarget.name}（${killTarget.id + 1}号）` : '无'} · 解药 {roleInfo?.witchState?.hasSave ? '✅' : '❌'} · 毒药 {roleInfo?.witchState?.hasPoison ? '✅' : '❌'}</div>
          <div className="flex flex-wrap gap-2 mb-4">
            {action.canSave && <button onClick={() => submitAction({ kind: 'nightSubmit', value: 'save' })} className="px-3 py-2 rounded-lg bg-green-900/40 border border-green-700/50 hover:bg-green-800/60 text-sm">🧪 使用解药</button>}
            {(action.canPoison ? action.targets : []).map(t => <button key={t.id} onClick={() => submitAction({ kind: 'nightSubmit', value: t.id })} className="px-3 py-2 rounded-lg bg-purple-900/40 border border-purple-700/50 hover:bg-purple-800/60 text-sm">☠️ {t.name}({t.id + 1}号)</button>)}
            <button onClick={() => submitAction({ kind: 'nightSubmit', value: 'skip' })} className="px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 hover:bg-gray-700 text-sm">🚫 不行动</button>
          </div>
        </div>
      );
    }
    if (action.type === 'nightIdle') {
      return <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800 text-sm text-gray-400">😴 {action.message || '本阶段不需要你的操作。'}</div>;
    }
    if (action.type === 'speech') {
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-blue-700/60">
          <div className="text-xl font-bold text-blue-300 mb-3">💬 轮到你发言</div>
          {action.wordLimitEnabled && <div className="text-xs text-gray-500 mb-2">字数要求：{action.wordLimitNum}字{action.wordLimitMode === 'min' ? '以上' : '以内'}</div>}
          <textarea value={speechText} onChange={e => setSpeechText(e.target.value)} className="w-full h-28 bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm mb-3" placeholder="请输入你的发言…" />
          <button onClick={() => submitAction({ kind: 'speechSubmit', text: speechText || '(未发言)' })} className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-6 py-3 rounded-xl w-full">确认发言</button>
        </div>
      );
    }
    if (action.type === 'vote') {
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-yellow-700/60">
          <div className="text-xl font-bold text-yellow-300 mb-3">🗳️ 请选择投票目标</div>
          <div className="flex flex-wrap gap-2 mb-4">
            {(action.targets || []).map(t => <button key={t.id} onClick={() => setVoteTarget(t.id)} className={`px-3 py-2 rounded-lg border text-sm ${voteTarget === t.id ? 'bg-yellow-700 border-yellow-500 text-white' : 'bg-gray-950 border-gray-700 hover:border-yellow-500 text-gray-200'}`}>{AVATARS[t.avatar]} {t.name}({t.id + 1}号)</button>)}
            <button onClick={() => setVoteTarget('abstain')} className={`px-3 py-2 rounded-lg border text-sm ${voteTarget === 'abstain' ? 'bg-orange-700 border-orange-500 text-white' : 'bg-gray-950 border-gray-700 hover:border-orange-500 text-gray-200'}`}>弃票</button>
          </div>
          <button onClick={() => voteTarget !== null && submitAction({ kind: 'voteSubmit', target: voteTarget })} disabled={voteTarget === null} className="bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-700 disabled:text-gray-500 text-black font-bold px-6 py-3 rounded-xl w-full">确认投票</button>
        </div>
      );
    }
    if (action.type === 'lastWords') {
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-amber-700/60">
          <div className="text-xl font-bold text-amber-300 mb-3">📜 请发表遗言</div>
          <textarea value={lastWordsText} onChange={e => setLastWordsText(e.target.value)} className="w-full h-28 bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-sm mb-3" placeholder="输入你的遗言…" />
          <div className="flex gap-2">
            <button onClick={() => submitAction({ kind: 'lastWordsSubmit', text: lastWordsText || '(无遗言)' })} className="bg-amber-600 hover:bg-amber-500 text-black font-bold px-6 py-3 rounded-xl flex-1">确认</button>
            <button onClick={() => submitAction({ kind: 'lastWordsSubmit', text: '(无遗言)' })} className="bg-gray-800 hover:bg-gray-700 text-white font-bold px-6 py-3 rounded-xl">跳过</button>
          </div>
        </div>
      );
    }
    if (action.type === 'hunterShot') {
      return (
        <div className="bg-gray-900 rounded-2xl p-5 border border-orange-700/60">
          <div className="text-xl font-bold text-orange-300 mb-3">🏹 猎人请选择开枪目标</div>
          <div className="flex flex-wrap gap-2 mb-4">{(action.targets || []).map(t => <button key={t.id} onClick={() => submitAction({ kind: 'hunterShotSubmit', target: t.id })} className="px-3 py-2 rounded-lg bg-orange-900/40 border border-orange-700/50 hover:bg-orange-800/60 text-sm">{AVATARS[t.avatar]} {t.name}({t.id + 1}号)</button>)}</div>
          <button onClick={() => submitAction({ kind: 'hunterShotSubmit', target: null })} className="bg-gray-800 hover:bg-gray-700 text-white font-bold px-6 py-3 rounded-xl w-full">不开枪</button>
        </div>
      );
    }
    return (
      <div className="bg-gray-900 rounded-2xl p-5 border border-gray-800">
        <div className="text-lg font-bold text-gray-200 mb-2">{action.title || '等待中'}</div>
        <div className="text-sm text-gray-400">{action.message || '等待流程推进。'}</div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white p-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1"><h1 className="text-2xl font-bold">🐺 房间 {roomState.id}</h1><span className="text-xs px-2 py-1 rounded bg-gray-900 border border-gray-700">{phaseLabel(viewer)}</span></div>
            <p className="text-sm text-gray-400">第 {viewer.round || 1} 轮 · 你的席位：{mySeat !== null && mySeat !== undefined ? `${mySeat + 1}号` : '旁观'} · 当前模式：{viewer.gameLabel || roomState.latestStateSummary?.gameLabel || '未知'}</p>
          </div>
          <div className="flex gap-2">
            <HornButton count={roomState.pendingAiCount || 0} onClick={onHorn} disabled={!myPlayer || !myPlayer.isHuman || (roomState.pendingAiCount || 0) <= 0} />
            <button onClick={onLeaveRoom} className="text-xs bg-gray-800 hover:bg-red-800 border border-gray-700 px-3 py-2 rounded-lg">离开房间</button>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1.2fr_0.95fr] gap-4">
          <div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-4">
              {(viewer.players || []).map(p => (
                <div key={p.id} className={`relative rounded-xl border p-3 ${p.alive ? 'bg-gray-900 border-gray-800' : 'bg-gray-900/50 border-gray-900 opacity-60'}`}>
                  <div className="text-3xl mb-1">{AVATARS[p.avatar]}</div>
                  <div className="text-xs text-gray-500">{p.id + 1}号 {p.isHuman ? '👤' : '🤖'}</div>
                  <div className="text-sm font-bold truncate">{p.name}</div>
                  <div className="text-xs mt-1 text-gray-500">{p.occupiedName ? `当前：${p.occupiedName}` : p.occupied ? '已占用' : '空位'}</div>
                  {!p.alive && <div className="text-xs text-red-400 mt-1">已出局</div>}
                  {p.role && <div className={`mt-2 inline-flex px-2 py-1 rounded text-xs font-bold ${p.role === 'werewolf' ? 'bg-red-900/60 text-red-300' : p.role === 'seer' ? 'bg-purple-900/60 text-purple-300' : p.role === 'witch' ? 'bg-teal-900/60 text-teal-300' : p.role === 'hunter' ? 'bg-orange-900/60 text-orange-300' : p.role === 'idiot' ? 'bg-pink-900/60 text-pink-300' : 'bg-green-900/60 text-green-300'}`}>{RM[p.role]}</div>}
                </div>
              ))}
            </div>

            {(viewer.speeches || []).length > 0 && (
              <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800 mb-4">
                <h2 className="text-sm font-bold text-blue-300 mb-3">💬 本轮发言</h2>
                <div className="max-h-56 overflow-y-auto space-y-2">{viewer.speeches.map((speech, idx) => <div key={idx} className="text-sm text-gray-300 bg-gray-950/60 border border-gray-800 rounded-xl px-3 py-2"><span className="text-blue-400 font-bold">{speech.name}：</span>{speech.text}</div>)}</div>
              </div>
            )}

            {(viewer.lastWordsList || []).length > 0 && (
              <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800 mb-4">
                <h2 className="text-sm font-bold text-amber-300 mb-3">📜 遗言</h2>
                <div className="max-h-40 overflow-y-auto space-y-2">{viewer.lastWordsList.map((lw, idx) => <div key={idx} className="text-sm text-gray-300 bg-gray-950/60 border border-gray-800 rounded-xl px-3 py-2"><span className="text-amber-400 font-bold">{lw.name}：</span>{lw.text}</div>)}</div>
              </div>
            )}

            {(viewer.gameHistory || []).length > 0 && (
              <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
                <h2 className="text-sm font-bold text-gray-300 mb-3">📚 对局记录</h2>
                <div className="max-h-72 overflow-y-auto space-y-1">{viewer.gameHistory.map((line, idx) => <div key={idx} className="text-xs text-gray-500">{line}</div>)}</div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {myPlayer && roleInfo && (
              <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
                <h2 className="text-sm font-bold text-yellow-300 mb-2">🪪 你的身份</h2>
                <div className="text-xl font-bold text-yellow-200 mb-1">{roleInfo.roleLabel || '未知'}</div>
                {roleInfo.role === 'werewolf' && roleInfo.wolfMates?.length > 0 && <div className="text-xs text-red-300">队友：{roleInfo.wolfMates.map(m => `${m.name}(${m.id + 1}号)${m.alive ? '' : '·出局'}`).join('、')}</div>}
                {roleInfo.role === 'seer' && roleInfo.seerHistory?.length > 0 && <div className="text-xs text-purple-300 mt-2">查验历史：{roleInfo.seerHistory.map(h => `${h.target + 1}号→${h.isWolf ? '狼人' : '好人'}`).join('、')}</div>}
                {roleInfo.role === 'witch' && roleInfo.witchState && <div className="text-xs text-teal-300 mt-2">解药 {roleInfo.witchState.hasSave ? '✅' : '❌'} · 毒药 {roleInfo.witchState.hasPoison ? '✅' : '❌'}</div>}
              </div>
            )}

            {viewer.phase === 'night' && (
              <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
                <div className="flex items-center justify-between mb-2"><h2 className="text-sm font-bold text-cyan-300">🤖 AI夜间进度</h2><span className="text-xs text-cyan-400">{viewer.nightProgressPct || 0}%</span></div>
                <div className="w-full h-2.5 bg-gray-800 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${viewer.nightProgressPct || 0}%`, background: 'linear-gradient(90deg,#0e7490,#06b6d4,#22d3ee)' }} /></div>
                <div className="text-xs text-gray-500 mt-2">{viewer.nightProgressLabel || '等待夜间处理…'}</div>
              </div>
            )}

            {viewer.nightResultMsg && viewer.phase !== 'night' && (
              <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
                <h2 className="text-sm font-bold text-green-300 mb-2">🌤️ 昨夜结果</h2>
                <div className="text-sm text-gray-300 whitespace-pre-line">{viewer.nightResultMsg}</div>
              </div>
            )}

            {renderActionCard()}
          </div>
        </div>
      </div>
    </div>
  );
}

function RootLobby({ client, onUpdateName, onCreateRoom, onJoinRoom, rooms, onRefreshRooms }) {
  const [nameInput, setNameInput] = useState(client.displayName || '玩家');
  const [roomCode, setRoomCode] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [createPrivate, setCreatePrivate] = useState(false);
  const [createPassword, setCreatePassword] = useState('');

  return (
    <div className="min-h-screen bg-gray-950 text-white p-4">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold mb-2">🐺 AI狼人杀远程联机版</h1>
          <p className="text-gray-400">保留原有AI狼人杀功能，并新增房间创建 / 加入 / 私密密码 / 远程人类联机 / AI加速喇叭。</p>
        </div>

        <div className="grid lg:grid-cols-[1.05fr_1fr] gap-4 mb-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-cyan-300 mb-3">👤 先设置你的联机昵称</h2>
            <div className="flex gap-2 mb-2">
              <input value={nameInput} onChange={e => setNameInput(e.target.value.slice(0, 24))} className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm" placeholder="你的昵称" />
              <button onClick={() => onUpdateName(nameInput || '玩家')} className="bg-cyan-700 hover:bg-cyan-600 text-white text-sm px-4 py-2 rounded-lg">保存</button>
            </div>
            <div className="text-xs text-gray-500">当前昵称：{client.displayName}</div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-yellow-300 mb-3">🏠 创建房间</h2>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm">私人房间</span>
              <button onClick={() => setCreatePrivate(v => !v)} className={`relative w-12 h-6 rounded-full ${createPrivate ? 'bg-yellow-600' : 'bg-gray-700'}`}><span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${createPrivate ? 'translate-x-6' : ''}`} /></button>
            </div>
            {createPrivate && <input value={createPassword} onChange={e => setCreatePassword(e.target.value.replace(/\D/g, '').slice(0, 6))} className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm mb-3" placeholder="6位数字密码" />}
            <button onClick={() => onCreateRoom({ isPrivate: createPrivate, password: createPassword })} className="bg-red-600 hover:bg-red-500 text-white font-bold px-6 py-3 rounded-xl w-full">创建房间</button>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1fr_1.2fr] gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-green-300 mb-3">🔑 通过房间号加入</h2>
            <div className="space-y-3">
              <input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase().slice(0, 6))} className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm" placeholder="输入房间号" />
              <input value={roomPassword} onChange={e => setRoomPassword(e.target.value.replace(/\D/g, '').slice(0, 6))} className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm" placeholder="如果是私人房间，这里输入6位密码" />
              <button onClick={() => onJoinRoom({ roomId: roomCode, password: roomPassword })} className="bg-green-600 hover:bg-green-500 text-white font-bold px-6 py-3 rounded-xl w-full">加入房间</button>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3"><h2 className="text-sm font-bold text-gray-200">🌐 公开房间</h2><button onClick={onRefreshRooms} className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-1.5 rounded-lg">刷新</button></div>
            <div className="space-y-2 max-h-[24rem] overflow-y-auto">
              {rooms.length > 0 ? rooms.map(room => (
                <button key={room.id} onClick={() => onJoinRoom({ roomId: room.id, password: '' })} className="w-full text-left bg-gray-950/70 border border-gray-800 rounded-xl px-4 py-3 hover:border-red-500 transition">
                  <div className="flex items-center justify-between gap-3"><div><div className="font-bold">房间 {room.id}</div><div className="text-xs text-gray-500 mt-1">房主：{room.hostName} · {room.gameLabel}</div></div><div className="text-right text-xs text-gray-500"><div>{room.connectedCount}人在线</div><div>{room.gameStarted ? '游戏中' : '等待开始'}</div></div></div>
                </button>
              )) : <div className="text-sm text-gray-500 py-8 text-center">暂无公开房间</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [client, setClient] = useState(() => loadClientIdentity());
  const [socket, setSocket] = useState(null);
  const [roomState, setRoomState] = useState(null);
  const [publicRooms, setPublicRooms] = useState([]);
  const roomId = roomState?.id || null;
  const isHostRoom = !!roomState?.isHost;
  const mySeatInRoom = roomState?.mySeat ?? null;
  const hostActionHandlerRef = useRef(null);
  const pendingAiResolversRef = useRef({});

  useEffect(() => {
    const s = io({ auth: { sessionId: client.sessionId, displayName: client.displayName } });
    setSocket(s);

    const onRoomState = payload => {
      if (payload?.room) setRoomState(payload.room);
    };
    const onRoomClosed = payload => {
      Object.values(pendingAiResolversRef.current).forEach(({ reject }) => reject(new Error(payload?.reason || '房间已关闭')));
      pendingAiResolversRef.current = {};
      setRoomState(null);
      alert(payload?.reason || '房间已关闭');
    };
    const onAction = payload => {
      if (hostActionHandlerRef.current) hostActionHandlerRef.current(payload?.action, payload || {});
    };
    const onAiResult = payload => {
      const resolver = pendingAiResolversRef.current[payload.requestId];
      if (!resolver) return;
      delete pendingAiResolversRef.current[payload.requestId];
      resolver.resolve(payload.response);
    };
    const onAiError = payload => {
      const resolver = pendingAiResolversRef.current[payload.requestId];
      if (!resolver) return;
      delete pendingAiResolversRef.current[payload.requestId];
      resolver.reject(new Error(payload.error || 'AI请求失败'));
    };
    const onAiCancelled = payload => {
      const resolver = pendingAiResolversRef.current[payload.requestId];
      if (!resolver) return;
      delete pendingAiResolversRef.current[payload.requestId];
      resolver.reject(new Error(payload.reason || 'AI请求已取消'));
    };

    s.on('room:state', onRoomState);
    s.on('room:closed', onRoomClosed);
    s.on('room:action', onAction);
    s.on('ai:result', onAiResult);
    s.on('ai:error', onAiError);
    s.on('ai:cancelled', onAiCancelled);
    s.emit('lobby:list', resp => setPublicRooms(resp?.rooms || []));

    return () => {
      s.off('room:state', onRoomState);
      s.off('room:closed', onRoomClosed);
      s.off('room:action', onAction);
      s.off('ai:result', onAiResult);
      s.off('ai:error', onAiError);
      s.off('ai:cancelled', onAiCancelled);
      s.close();
    };
  }, [client.sessionId]);

  useEffect(() => {
    if (!socket) return;
    socket.emit('profile:update', { displayName: client.displayName });
  }, [socket, client.displayName]);

  const refreshRooms = useCallback(() => {
    if (!socket) return;
    socket.emit('lobby:list', resp => setPublicRooms(resp?.rooms || []));
  }, [socket]);

  const updateName = useCallback((displayName) => {
    const next = { ...client, displayName: String(displayName || '玩家').slice(0, 24) || '玩家' };
    setClient(next);
    saveClientIdentity(next);
    if (socket) socket.emit('profile:update', { displayName: next.displayName });
  }, [client, socket]);

  const createRoom = useCallback(({ isPrivate, password }) => {
    if (!socket) return;
    socket.emit('room:create', { isPrivate, password }, resp => {
      if (!resp?.ok) alert(resp?.error || '创建房间失败');
      else refreshRooms();
    });
  }, [socket, refreshRooms]);

  const joinRoom = useCallback(({ roomId, password }) => {
    if (!socket) return;
    socket.emit('room:join', { roomId, password }, resp => {
      if (!resp?.ok) alert(resp?.error || '加入房间失败');
      else refreshRooms();
    });
  }, [socket, refreshRooms]);

  const leaveRoom = useCallback(() => {
    if (!socket || !roomId) return;
    socket.emit('room:leave', { roomId }, () => {
      Object.values(pendingAiResolversRef.current).forEach(({ reject }) => reject(new Error('已离开房间')));
      pendingAiResolversRef.current = {};
      setRoomState(null);
      refreshRooms();
    });
  }, [socket, roomId, refreshRooms]);

  const claimSeat = useCallback((seatId) => {
    if (!socket || !roomId) return;
    socket.emit('room:claimSeat', { roomId, seatId }, resp => {
      if (!resp?.ok) alert(resp?.error || '加入席位失败');
    });
  }, [socket, roomId]);

  const releaseSeat = useCallback(() => {
    if (!socket || !roomId) return;
    socket.emit('room:releaseSeat', { roomId });
  }, [socket, roomId]);

  const registerHostActionHandler = useCallback((handler) => {
    hostActionHandlerRef.current = handler;
    return () => {
      if (hostActionHandlerRef.current === handler) hostActionHandlerRef.current = null;
    };
  }, []);

  const pushHostSnapshot = useCallback((snapshot) => {
    if (!socket || !roomId || !isHostRoom) return;
    socket.emit('room:hostSnapshot', { roomId, snapshot });
  }, [socket, roomId, isHostRoom]);

  const updateApiConfigs = useCallback((configs) => {
    if (!socket || !roomId || !isHostRoom) return;
    socket.emit('room:setApiConfigs', { roomId, configs });
  }, [socket, roomId, isHostRoom]);

  const requestAI = useCallback((playerId, prompt) => {
    if (!socket || !roomId || !isHostRoom) return Promise.reject(new Error('当前不在房间中'));
    return new Promise((resolve, reject) => {
      const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      pendingAiResolversRef.current[requestId] = { resolve, reject };
      socket.emit('ai:request', { roomId, requestId, playerId, prompt }, resp => {
        if (resp?.ok) return;
        delete pendingAiResolversRef.current[requestId];
        reject(new Error(resp?.error || 'AI请求失败'));
      });
    });
  }, [socket, roomId, isHostRoom]);

  const accelerateAI = useCallback(() => {
    if (!socket || !roomId) return;
    socket.emit('room:accelerateAi', { roomId }, resp => {
      if (resp?.ok === false) alert(resp?.error || '加速失败');
    });
  }, [socket, roomId]);

  const cancelPendingAI = useCallback(() => {
    if (!socket || !roomId || !isHostRoom) return;
    socket.emit('room:cancelAi', { roomId });
    Object.values(pendingAiResolversRef.current).forEach(({ reject }) => reject(new Error('AI请求已取消')));
    pendingAiResolversRef.current = {};
  }, [socket, roomId, isHostRoom]);

  const sendRemoteAction = useCallback((action) => {
    if (!socket || !roomId) return;
    socket.emit('room:action', { roomId, action }, resp => {
      if (resp?.ok === false) alert(resp?.error || '提交失败');
    });
  }, [socket, roomId]);

  const hostNetwork = useMemo(() => ({
    enabled: !!roomState?.isHost,
    isHost: !!roomState?.isHost,
    mySeat: mySeatInRoom ?? 0,
    roomState,
    registerHostActionHandler,
    pushHostSnapshot,
    updateApiConfigs,
    requestAI,
    accelerateAI,
    cancelPendingAI,
    leaveRoom,
  }), [roomState, mySeatInRoom, registerHostActionHandler, pushHostSnapshot, updateApiConfigs, requestAI, accelerateAI, cancelPendingAI, leaveRoom]);

  if (!roomState) {
    return <RootLobby client={client} onUpdateName={updateName} onCreateRoom={createRoom} onJoinRoom={joinRoom} rooms={publicRooms} onRefreshRooms={refreshRooms} />;
  }

  if (roomState.isHost) {
    return <WerewolfGame network={hostNetwork} />;
  }

  if (!roomState.gameStarted) {
    return <RemoteLobbyView roomState={roomState} client={client} onUpdateName={updateName} onClaimSeat={claimSeat} onReleaseSeat={releaseSeat} onLeaveRoom={leaveRoom} onRefreshRooms={refreshRooms} />;
  }

  return <RemotePlayerView roomState={roomState} onAction={sendRemoteAction} onHorn={accelerateAI} onLeaveRoom={leaveRoom} />;
}


function WerewolfGame({network}){
  const [phase,setPhase]=useState('setup');
  const [gameMode,setGameMode]=useState(1);
  const [players,setPlayers]=useState(()=>initPlayers(MODE_CONFIGS[1].roles.length));
  const [judge,setJudge]=useState('system');
  const [enc,setEnc]=useState(null);
  const [round,setRound]=useState(1);
  const [step,setStep]=useState(null);
  const [stepQueue,setStepQueue]=useState([]);
  const [qIdx,setQIdx]=useState(0);
  const [promptText,setPromptText]=useState('');
  const [responseText,setResponseText]=useState('');
  const [nightKill,setNightKill]=useState(null);
  const [wolfVotes,setWolfVotes]=useState({});
  const [witchHasSave,setWitchHasSave]=useState(true);
  const [witchHasPoison,setWitchHasPoison]=useState(true);
  const [seerHistory,setSeerHistory]=useState([]);
  const [speeches,setSpeeches]=useState([]);
  const [votes,setVotes]=useState({});
  const [log,setLog]=useState([]);
  const [copied,setCopied]=useState(false);
  const [copiedId,setCopiedId]=useState(null);
  const [editName,setEditName]=useState(null);
  const [personalityPicker,setPersonalityPicker]=useState(null);
  const [customPersonalityInput,setCustomPersonalityInput]=useState('');
  const [humanAction,setHumanAction]=useState(null);
  const [showRole,setShowRole]=useState(null);
  const [gameResult,setGameResult]=useState(null);
  const [nightResultMsg,setNightResultMsg]=useState('');
  const [showTransition,setShowTransition]=useState(false);
  const [transitionTarget,setTransitionTarget]=useState(null);
  const [transitionCallback,setTransitionCallback]=useState(null);
  const [voteOrder,setVoteOrder]=useState([]);
  const [votingActive,setVotingActive]=useState(false);
  const [selectedVoter,setSelectedVoter]=useState(null);
  const [selectedVoteTarget,setSelectedVoteTarget]=useState(null);
  const [hunterShotPending,setHunterShotPending]=useState(null);
  const [hunterShotContext,setHunterShotContext]=useState(null);

  const [nightHumanQueue,setNightHumanQueue]=useState([]);
  const [nightHumanQIdx,setNightHumanQIdx]=useState(-1);
  const [nightHumanState,setNightHumanState]=useState(null);
  const [seerCheckResult,setSeerCheckResult]=useState(null);

  // Manual mode state
  const [nightPrompts,setNightPrompts]=useState({});
  const [nightResponseMap,setNightResponseMap]=useState({});
  const [expandedPlayerId,setExpandedPlayerId]=useState(null);

  // Settings
  const [enableLastWords,setEnableLastWords]=useState(false);
  const [allowNightLastWords,setAllowNightLastWords]=useState(true);
  const [onlyFirstNightLW,setOnlyFirstNightLW]=useState(false);
  const [showAllRolesModal,setShowAllRolesModal]=useState(false);
  const [adminCustomRoles,setAdminCustomRoles]=useState(false);
  const [customRoleAssign,setCustomRoleAssign]=useState({});
  const [revealDeadIdentity,setRevealDeadIdentity]=useState(false);
  const [lastWordsList,setLastWordsList]=useState([]);
  const [dayVoteHistory,setDayVoteHistory]=useState([]);
  const [wordLimitEnabled,setWordLimitEnabled]=useState(false);
  const [wordLimitNum,setWordLimitNum]=useState(200);
  const [wordLimitMode,setWordLimitMode]=useState('max');
  const [personalityHardcore,setPersonalityHardcore]=useState(false);
  const [speechOrderMode,setSpeechOrderMode]=useState(3);
  const [lastDeadIds,setLastDeadIds]=useState([]);
  const [enhanceAI,setEnhanceAI]=useState(false);
  const [adminMode,setAdminMode]=useState(false);

  // Last words phase
  const [lwQueue,setLwQueue]=useState([]);
  const [lwQIdx,setLwQIdx]=useState(0);
  const [lwInput,setLwInput]=useState('');
  const [lwPromptText,setLwPromptText]=useState('');
  const [lwResponseText,setLwResponseText]=useState('');
  const [lwAfterCallback,setLwAfterCallback]=useState(null);
  const [lwContext,setLwContext]=useState(null);

  // ===== API AUTO MODE =====
  const [apiAutoMode,setApiAutoMode]=useState(false);
  const [apiConfigs,setApiConfigs]=useState(()=>{try{const s=window._apiConfigStore;if(s)return s;const raw=document.cookie.split(';').find(c=>c.trim().startsWith('ww_api='));return {};}catch(e){return {};}});
  const [apiConfigModal,setApiConfigModal]=useState(null);
  const [gameHistory,setGameHistory]=useState([]);
  const [apiStatus,setApiStatus]=useState({});
  const [nightProgressPct,setNightProgressPct]=useState(0);
  const [nightProgressLabel,setNightProgressLabel]=useState('');
  const [logExpanded,setLogExpanded]=useState(false);
  const [showLog,setShowLog]=useState(false);

  // Load API configs from localStorage on mount
  useEffect(()=>{try{const raw=localStorage.getItem('werewolf_api_configs');if(raw){const parsed=JSON.parse(raw);setApiConfigs(parsed);R.current.apiConfigs=parsed;}}catch(e){}},[]);
  // Save API configs to localStorage whenever they change
  const saveApiConfigs=(nc)=>{setApiConfigs(nc);R.current.apiConfigs=nc;try{localStorage.setItem('werewolf_api_configs',JSON.stringify(nc));}catch(e){}if(roomMode&&network?.updateApiConfigs)network.updateApiConfigs(nc);};
  const [showAllRoles,setShowAllRoles]=useState(false);
  const roomMode=!!network?.enabled;
  const mySeat=network?.mySeat??0;
  const roomStateMeta=network?.roomState||null;
  const roomMembers=roomStateMeta?.members||[];
  const roomPendingAiCount=roomStateMeta?.pendingAiCount||0;

  // Refs for async access
  const R=useRef({
    players:initPlayers(MODE_CONFIGS[1].roles.length),wolfVotes:{},nightKill:null,seerHistory:[],
    witchSave:true,witchPoison:true,witchSaved:false,witchPoisonTarget:null,
    lastWords:[],voteHistory:[],lastDead:[],gameHistory:[],apiConfigs:{},
    apiAutoMode:false,enhanceAI:false,adminMode:false,adminModeAvail:false,enableLW:false,allowNightLW:true,onlyFirstNightLW:false,revealDead:false,
    wordLimit:false,wordLimitNum:200,wordLimitMode:'max',speechOrder:3,personalityHardcore:false,
    gameMode:1,round:1,
    // API sub-phase tracking
    apiResults:{},apiDoneCount:0,apiTotalCount:0,humanDone:false,subPhaseCallback:null,firstNightRoleShown:false,
    apiRunId:1,apiAbortReason:'',apiAbortControllers:new Set(),apiSleepCancels:new Set(),flowTimers:new Set(),pendingVotes:{},pendingVoteHumans:[],aiVoteDone:false,
  });

  const syncRef=(key,val)=>{R.current[key]=val;};
  const setPlayersSync=v=>{if(typeof v==='function'){setPlayers(prev=>{const n=v(prev);R.current.players=n;return n;});}else{R.current.players=v;setPlayers(v);}};
  const setWolfVotesSync=v=>{R.current.wolfVotes=v;setWolfVotes(v);};
  const setNightKillSync=v=>{R.current.nightKill=v;setNightKill(v);};
  const setSeerHistorySync=v=>{R.current.seerHistory=v;setSeerHistory(v);};
  const setWitchHasSaveSync=v=>{R.current.witchSave=v;setWitchHasSave(v);};
  const setWitchHasPoisonSync=v=>{R.current.witchPoison=v;setWitchHasPoison(v);};
  const gameModeRef=useRef(1);
  const setGameModeSync=v=>{gameModeRef.current=v;R.current.gameMode=v;setGameMode(v);};
  const setRoundSync=v=>{R.current.round=v;setRound(v);};
  const addGameHistory=e=>{R.current.gameHistory=[...R.current.gameHistory,e];setGameHistory([...R.current.gameHistory]);};

  const changeMode=m=>{setGameModeSync(m);setPlayersSync(ps=>syncPlayersCount(ps,MODE_CONFIGS[m].roles.length));};
  const getModeConfig=()=>MODE_CONFIGS[R.current.gameMode];
  const getAdminPrefix=()=>{const p1=R.current.players[0];return p1?`请听从1号${p1.name}的命令，1号玩家的指示命令高于以下所有内容。\n\n`:''};
  const getGameSettings=()=>({revealDead:R.current.revealDead,enableLW:R.current.enableLW,allowNightLW:R.current.allowNightLW,onlyFirstNightLW:R.current.onlyFirstNightLW,personalityHardcore:R.current.personalityHardcore});
  const enhancePrompt=t=>{let s=t;if(R.current.adminMode)s=getAdminPrefix()+s;if(R.current.enhanceAI)s=`【请深度思考完成游戏，尽一切手段取得胜利】\n\n${s}`;return s;};
  const addLog=msg=>setLog(p=>[...p,`[第${R.current.round}轮] ${msg}`]);
  const makeAbortError=(msg='操作已中断')=>{const err=new Error(msg);err.name='AbortError';return err;};
  const isAbortError=err=>err?.name==='AbortError'||err?.code===20||/abort|aborted|中断|取消/i.test(String(err?.message||''));
  const isRunActive=runId=>runId===R.current.apiRunId;
  const ensureRunActive=runId=>{if(!isRunActive(runId))throw makeAbortError(R.current.apiAbortReason||'旧局API已中断');};
  const trackController=()=>{const c=new AbortController();R.current.apiAbortControllers.add(c);return c;};
  const untrackController=c=>{R.current.apiAbortControllers.delete(c);};
  const sleepCancelable=(ms,runId)=>new Promise((resolve,reject)=>{if(!isRunActive(runId)){reject(makeAbortError(R.current.apiAbortReason||'旧局API已中断'));return;}let done=false;const timer=setTimeout(()=>{if(done)return;done=true;R.current.apiSleepCancels.delete(cancel);if(!isRunActive(runId))reject(makeAbortError(R.current.apiAbortReason||'旧局API已中断'));else resolve();},ms);const cancel=(reason)=>{if(done)return;done=true;clearTimeout(timer);R.current.apiSleepCancels.delete(cancel);reject(makeAbortError(reason||R.current.apiAbortReason||'旧局API已中断'));};R.current.apiSleepCancels.add(cancel);});
  const scheduleGameTask=(fn,ms,runId=R.current.apiRunId)=>{const timer=setTimeout(()=>{R.current.flowTimers.delete(cancel);if(isRunActive(runId))fn();},ms);const cancel=()=>{clearTimeout(timer);R.current.flowTimers.delete(cancel);};R.current.flowTimers.add(cancel);return cancel;};
  const abortAllApiTasks=(reason='游戏已重置，停止旧局API')=>{R.current.apiAbortReason=reason;R.current.apiRunId=(R.current.apiRunId||0)+1;if(roomMode&&network?.cancelPendingAI){try{network.cancelPendingAI();}catch(e){}}for(const c of Array.from(R.current.apiAbortControllers||[])){try{c.abort(reason);}catch(e){}}R.current.apiAbortControllers=new Set();for(const cancel of Array.from(R.current.apiSleepCancels||[])){try{cancel(reason);}catch(e){}}R.current.apiSleepCancels=new Set();for(const cancel of Array.from(R.current.flowTimers||[])){try{cancel();}catch(e){}}R.current.flowTimers=new Set();R.current.subPhaseCallback=null;R.current.speechCallback=null;R.current._wolfSeerMarkDone=null;R.current.pendingVotes={};R.current.pendingVoteHumans=[];R.current.aiVoteDone=false;};

  /* FIX: Helper to get filtered game history for a specific player */
  const getFilteredGH=(player)=>filterGameHistoryForPlayer(R.current.gameHistory, player, R.current.players);

  const copyText=(text,id)=>{
    const ok=()=>{setCopied(true);setCopiedId(id??true);setTimeout(()=>{setCopied(false);setCopiedId(null);},1500);};
    if(navigator.clipboard?.writeText)navigator.clipboard.writeText(text).then(ok).catch(()=>{try{const ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;left:-9999px';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);ok();}catch(e){alert('复制失败');}});
    else{try{const ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;left:-9999px';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);ok();}catch(e){alert('复制失败');}}
  };

  const buildHostSnapshot=useCallback(()=>({
    phase,gameMode,judge,round,step,stepQueue:[...stepQueue],qIdx,
    players:JSON.parse(JSON.stringify(players)),nightKill,wolfVotes:{...wolfVotes},witchHasSave,witchHasPoison,
    seerHistory:JSON.parse(JSON.stringify(seerHistory)),speeches:JSON.parse(JSON.stringify(speeches)),votes:JSON.parse(JSON.stringify(votes)),voteOrder:[...voteOrder],votingActive,selectedVoter,
    gameResult,nightResultMsg,hunterShotPending,hunterShotContext,nightHumanQueue:[...nightHumanQueue],nightHumanQIdx,nightHumanState,
    seerCheckResult:seerCheckResult?{...seerCheckResult}:null,enableLastWords,allowNightLastWords,onlyFirstNightLW,revealDeadIdentity,lastWordsList:JSON.parse(JSON.stringify(lastWordsList)),
    dayVoteHistory:JSON.parse(JSON.stringify(dayVoteHistory)),wordLimitEnabled,wordLimitNum,wordLimitMode,personalityHardcore,speechOrderMode,lastDeadIds:[...lastDeadIds],enhanceAI,adminMode,
    lwQueue:[...lwQueue],lwQIdx,lwContext,apiAutoMode,gameHistory:JSON.parse(JSON.stringify(gameHistory)),apiStatus:JSON.parse(JSON.stringify(apiStatus)),nightProgressPct,nightProgressLabel,log:JSON.parse(JSON.stringify(log))
  }),[phase,gameMode,judge,round,step,stepQueue,qIdx,players,nightKill,wolfVotes,witchHasSave,witchHasPoison,seerHistory,speeches,votes,voteOrder,votingActive,selectedVoter,gameResult,nightResultMsg,hunterShotPending,hunterShotContext,nightHumanQueue,nightHumanQIdx,nightHumanState,seerCheckResult,enableLastWords,allowNightLastWords,onlyFirstNightLW,revealDeadIdentity,lastWordsList,dayVoteHistory,wordLimitEnabled,wordLimitNum,wordLimitMode,personalityHardcore,speechOrderMode,lastDeadIds,enhanceAI,adminMode,lwQueue,lwQIdx,lwContext,apiAutoMode,gameHistory,apiStatus,nightProgressPct,nightProgressLabel,log]);

  const remoteActionRouterRef=useRef(null);
  remoteActionRouterRef.current=(action)=>{};

  const registerHostActionHandler=network?.registerHostActionHandler;
  const pushHostSnapshot=network?.pushHostSnapshot;
  const updateRoomApiConfigs=network?.updateApiConfigs;

  useEffect(()=>{
    if(roomMode&&registerHostActionHandler){
      return registerHostActionHandler((action,payload)=>{if(remoteActionRouterRef.current)remoteActionRouterRef.current(action,payload);});
    }
  },[roomMode,registerHostActionHandler]);

  useEffect(()=>{
    if(roomMode&&pushHostSnapshot){pushHostSnapshot(buildHostSnapshot());}
  },[roomMode,pushHostSnapshot,buildHostSnapshot]);

  useEffect(()=>{
    if(roomMode&&updateRoomApiConfigs){updateRoomApiConfigs(apiConfigs);}
  },[roomMode,updateRoomApiConfigs,apiConfigs]);

  const checkWin=useCallback(ps=>{
    const mc=MODE_CONFIGS[R.current.gameMode]||MODE_CONFIGS[1];
    const aw=ps.filter(p=>p.alive&&p.role==='werewolf').length;
    if(aw===0)return 'good';
    if(mc.winRule==='edge'){if(ps.filter(p=>p.alive&&p.role==='villager').length===0||ps.filter(p=>p.alive&&(mc.specialRoles||[]).includes(p.role)).length===0)return 'wolf';return null;}
    if(aw>=ps.filter(p=>p.alive&&p.role!=='werewolf').length)return 'wolf';
    return null;
  },[]);

  const doTransition=(tp,cb)=>{if(roomMode){if(cb)cb();return;}setShowTransition(true);setTransitionTarget(tp);setTransitionCallback(()=>cb);};
  const confirmTransition=()=>{setShowTransition(false);const cb=transitionCallback;setTransitionTarget(null);setTransitionCallback(null);if(cb)cb();};

  /* ===== API CALL HELPER ===== */
  const callAI=async(pid,prompt,runId=R.current.apiRunId)=>{
    ensureRunActive(runId);
    const cfg=R.current.apiConfigs[pid];
    if(!cfg?.apiKey||!cfg?.apiUrl)throw new Error(`${pid+1}号未配置API`);
    let fp=prompt;
    if(R.current.adminMode)fp=getAdminPrefix()+fp;
    if(R.current.enhanceAI)fp=`【请深度思考完成游戏，尽一切手段取得胜利】\n\n${fp}`;
    const pName=R.current.players[pid]?.name||pid+1+'号';
    const requestOnce=async()=>{
      ensureRunActive(runId);
      if(roomMode&&network?.requestAI){
        try{const resp=await network.requestAI(pid,fp);ensureRunActive(runId);return resp;}catch(err){if(!isRunActive(runId))throw makeAbortError(R.current.apiAbortReason||'旧局API已中断');throw err;}
      }
      const controller=trackController();
      try{
        const resp=await callPlayerAPI(cfg,fp,controller.signal);
        ensureRunActive(runId);
        return resp;
      }catch(err){
        if(controller.signal.aborted||!isRunActive(runId))throw makeAbortError(R.current.apiAbortReason||'旧局API已中断');
        throw err;
      }finally{
        untrackController(controller);
      }
    };
    let lastErr;
    for(let i=1;i<=2;i++){
      try{return await requestOnce();}catch(err){if(isAbortError(err)||!isRunActive(runId))throw makeAbortError(R.current.apiAbortReason||'旧局API已中断');lastErr=err;if(i<2){addLog(`⚠️ ${pName} API第${i}次失败，正在重试...`);await sleepCancelable(1000,runId);}}
    }
    for(let i=1;i<=2;i++){
      const d=2000+Math.random()*8000;addLog(`⚠️ ${pName} API连续失败，${(d/1000).toFixed(1)}秒后第${2+i}次重试...`);await sleepCancelable(d,runId);
      try{return await requestOnce();}catch(err){if(isAbortError(err)||!isRunActive(runId))throw makeAbortError(R.current.apiAbortReason||'旧局API已中断');lastErr=err;}
    }
    {const d=6000+Math.random()*9000;addLog(`⚠️ ${pName} API仍然失败，${(d/1000).toFixed(1)}秒后最后一次重试...`);await sleepCancelable(d,runId);
    try{return await requestOnce();}catch(err){if(isAbortError(err)||!isRunActive(runId))throw makeAbortError(R.current.apiAbortReason||'旧局API已中断');lastErr=err;}}
    throw lastErr;
  };

  /* ===== API AUTO: fire calls for a night sub-phase, resolve when all AI+human done ===== */
  const fireApiNightCalls=async(sub,ps,r,extraCtx,onAllDone,runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    const mc=getModeConfig();
    const aiPlayers=ps.filter(p=>p.alive&&!p.isHuman&&R.current.apiConfigs[p.id]);
    const relevantAI=aiPlayers.filter(p=>{
      if(sub==='wolf')return p.role==='werewolf';
      if(sub==='seer')return p.role==='seer';
      if(sub==='witch')return p.role==='witch';
      return false;
    });

    R.current.subPhaseCallback=onAllDone;
    R.current.apiResults={};
    R.current.apiTotalCount=relevantAI.length;
    R.current.apiDoneCount=0;
    const hasHumanActive=ps.some(p=>p.isHuman&&p.alive);
    if(!R.current.humanDone) R.current.humanDone=!hasHumanActive;

    const tryFinish=()=>{
      if(!isRunActive(runId))return;
      if(R.current.apiDoneCount>=R.current.apiTotalCount&&R.current.humanDone){
        const cb=R.current.subPhaseCallback;
        R.current.subPhaseCallback=null;
        if(cb)cb(R.current.apiResults);
      }
    };

    if(relevantAI.length===0){tryFinish();return;}

    const newStatus={};
    relevantAI.forEach(p=>{newStatus[p.id]='pending';});
    setApiStatus(prev=>({...prev,...newStatus}));

    for(const p of relevantAI){
      (async()=>{
        try{
          let prompt;
          const filteredGH=filterGameHistoryForPlayer(R.current.gameHistory,p,ps);
          const ghCtx={mc,round:r,gh:filteredGH,seerHistory:R.current.seerHistory,wolfVotes:R.current.wolfVotes,nightKill:R.current.nightKill,witchSave:R.current.witchSave,witchPoison:R.current.witchPoison,settings:getGameSettings(),...extraCtx};
          if(sub==='wolf')prompt=plainWolfPrompt(p,ps,ghCtx);
          else if(sub==='seer')prompt=plainSeerPrompt(p,ps,ghCtx);
          else if(sub==='witch')prompt=plainWitchPrompt(p,ps,ghCtx);
          const resp=await callAI(p.id,prompt,runId);
          if(!isRunActive(runId))return;
          const pa=parsePlainAction(resp);
          R.current.apiResults[p.id]={raw:resp,parsed:pa};
          R.current.apiDoneCount++;
          setApiStatus(prev=>({...prev,[p.id]:'done'}));
          addLog(`🤖 ${p.name} API回复: ${resp.substring(0,80)}...`);
        }catch(err){
          if(isAbortError(err)||!isRunActive(runId))return;
          R.current.apiResults[p.id]={raw:'',parsed:null,error:err.message};
          R.current.apiDoneCount++;
          setApiStatus(prev=>({...prev,[p.id]:'error:'+err.message}));
          addLog(`❌ ${p.name} API错误: ${err.message}`);
        }
        tryFinish();
      })();
    }
    if(!hasHumanActive&&relevantAI.length===0)tryFinish();
  };

  const markHumanDone=()=>{
    R.current.humanDone=true;
    // wolfSeer combined phase uses custom callback
    if(R.current._wolfSeerMarkDone){R.current._wolfSeerMarkDone();return;}
    // Standard fireApiNightCalls (witch phase)
    if(R.current.apiDoneCount>=R.current.apiTotalCount&&R.current.subPhaseCallback){
      const cb=R.current.subPhaseCallback;
      R.current.subPhaseCallback=null;
      cb(R.current.apiResults);
    }
  };

  /* ===== NIGHT FLOW (API mode) ===== */
  const startNightAPI=(ps,r,runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    setPhase('night');setWolfVotesSync({});setNightKillSync(null);
    R.current.witchSaved=false;R.current.witchPoisonTarget=null;
    setStep('wolfSeer');setHumanAction(null);setResponseText('');

    const humansPending=setupNightHumanPhase(ps,'wolfSeer');

    addGameHistory(`\n===== 第${r}轮夜晚 =====`);
    setNightProgressPct(10);setNightProgressLabel('狼人·预言家行动中');

    const mc=getModeConfig();
    const aiWolves=ps.filter(p=>p.alive&&!p.isHuman&&R.current.apiConfigs[p.id]&&p.role==='werewolf');
    const aiSeers=ps.filter(p=>p.alive&&!p.isHuman&&R.current.apiConfigs[p.id]&&p.role==='seer');
    const totalApiCount=aiWolves.length+aiSeers.length;
    let apiDoneCount=0;
    const wolfResults={},seerResults={};

    R.current.humanDone=!humansPending;
    R.current.subPhaseCallback=null;

    const tryFinishWolfSeer=()=>{
      if(!isRunActive(runId))return;
      if(apiDoneCount<totalApiCount||!R.current.humanDone)return;

      const wv={...R.current.wolfVotes};
      for(const[id,res]of Object.entries(wolfResults)){
        if(res.parsed?.target!==null&&typeof res.parsed?.target==='number')wv[+id]=res.parsed.target;
      }
      setWolfVotesSync(wv);
      const cc={};Object.values(wv).forEach(t=>{cc[t]=(cc[t]||0)+1;});
      let kill=null;
      if(Object.keys(cc).length>0){const mx=Math.max(...Object.values(cc));const tops=Object.entries(cc).filter(([,v])=>v===mx).map(([k])=>+k);kill=tops.length===1?tops[0]:tops[0|Math.random()*tops.length];}
      setNightKillSync(kill);
      addGameHistory(`[夜晚-狼人] 投票:${Object.entries(wv).map(([k,v])=>`${ps[k].name}→${ps[v].name}`).join('、')}${kill!==null?` → 击杀${ps[kill].name}`:''}`);

      for(const[id,res]of Object.entries(seerResults)){
        if(res.parsed?.target!==null&&typeof res.parsed?.target==='number'){
          const iw=ps[res.parsed.target].role==='werewolf';
          const nh=[...R.current.seerHistory,{target:res.parsed.target,isWolf:iw}];
          setSeerHistorySync(nh);
          addGameHistory(`[夜晚-预言家] ${ps[id].name}查验${ps[res.parsed.target].name}(${res.parsed.target+1}号)→${iw?'狼人':'好人'}`);
          addLog(`🔮 预言家查验 ${ps[res.parsed.target].name}: ${iw?'狼人':'好人'}`);
        }
      }

      setNightProgressPct(50);setNightProgressLabel('女巫行动中');
      startWitchPhaseAPI(ps,r,R.current.nightKill,runId);
    };

    R.current.subPhaseCallback=()=>tryFinishWolfSeer();
    const origMarkHumanDone=()=>{
      R.current.humanDone=true;
      tryFinishWolfSeer();
    };
    R.current._wolfSeerMarkDone=origMarkHumanDone;

    for(const p of aiWolves){
      (async()=>{
        try{
          const filteredGH=filterGameHistoryForPlayer(R.current.gameHistory,p,ps);
          const ghCtx={mc,round:r,gh:filteredGH,seerHistory:R.current.seerHistory,wolfVotes:R.current.wolfVotes,nightKill:R.current.nightKill,witchSave:R.current.witchSave,witchPoison:R.current.witchPoison,settings:getGameSettings()};
          const resp=await callAI(p.id,plainWolfPrompt(p,ps,ghCtx),runId);
          if(!isRunActive(runId))return;
          wolfResults[p.id]={raw:resp,parsed:parsePlainAction(resp)};
          addLog(`🤖 ${p.name} API回复: ${resp.substring(0,80)}...`);
        }catch(err){
          if(isAbortError(err)||!isRunActive(runId))return;
          wolfResults[p.id]={raw:'',parsed:null,error:err.message};
          addLog(`❌ ${p.name} API错误: ${err.message}`);
        }
        apiDoneCount++;tryFinishWolfSeer();
      })();
    }
    for(const p of aiSeers){
      (async()=>{
        try{
          const filteredGH=filterGameHistoryForPlayer(R.current.gameHistory,p,ps);
          const ghCtx={mc,round:r,gh:filteredGH,seerHistory:R.current.seerHistory,settings:getGameSettings()};
          const resp=await callAI(p.id,plainSeerPrompt(p,ps,ghCtx),runId);
          if(!isRunActive(runId))return;
          seerResults[p.id]={raw:resp,parsed:parsePlainAction(resp)};
          addLog(`🤖 ${p.name} API回复: ${resp.substring(0,80)}...`);
        }catch(err){
          if(isAbortError(err)||!isRunActive(runId))return;
          seerResults[p.id]={raw:'',parsed:null,error:err.message};
          addLog(`❌ ${p.name} API错误: ${err.message}`);
        }
        apiDoneCount++;tryFinishWolfSeer();
      })();
    }
    if(totalApiCount===0)tryFinishWolfSeer();
  };

  const startWitchPhaseAPI=(ps,r,kill,runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    R.current._wolfSeerMarkDone=null;
    if(!ps.some(p=>p.alive&&p.role==='witch')){resolveNight(kill,false,null,runId);return;}
    setStep('witch');setHumanAction(null);
    setNightProgressPct(70);setNightProgressLabel('女巫行动中');
    const witchHumansPending=setupNightHumanPhase(ps,'witch');
    R.current.humanDone=!witchHumansPending;

    fireApiNightCalls('witch',ps,r,{nightKill:kill},apiResults=>{
      if(!isRunActive(runId))return;
      let saved=R.current.witchSaved,poison=R.current.witchPoisonTarget;
      for(const[id,res]of Object.entries(apiResults)){
        if(res.parsed){
          if(res.parsed.action==='save'){saved=true;setWitchHasSaveSync(false);addGameHistory(`[夜晚-女巫] ${ps[id].name}使用解药`);addLog(`🧪 女巫救人`);}
          else if(res.parsed.action==='poison'&&res.parsed.target!==null&&typeof res.parsed.target==='number'){poison=res.parsed.target;setWitchHasPoisonSync(false);addGameHistory(`[夜晚-女巫] ${ps[id].name}毒杀${ps[res.parsed.target].name}`);addLog(`☠️ 女巫毒杀 ${ps[res.parsed.target].name}`);}
          else{addGameHistory(`[夜晚-女巫] ${ps[id].name}不行动`);}
        }
      }
      resolveNight(R.current.nightKill,saved,poison,runId);
    },runId);
  };

  /* ===== RESOLVE NIGHT (shared) ===== */
  const resolveNight=(kill,save,poison,runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    setNightProgressPct(95);setNightProgressLabel('结算中');
    const np=[...R.current.players];let ms=[];const deadIds=[];const poisonedIds=new Set();if(poison!==null)poisonedIds.add(poison);
    const rd=R.current.revealDead;
    if(kill!==null&&!save){np[kill]={...np[kill],alive:false};ms.push(`${np[kill].name}(${kill+1}号${rd?'·'+RM[np[kill].role]:''})昨晚被杀`);deadIds.push(kill);}
    else if(kill!==null&&save)ms.push('昨晚平安夜(女巫救人)');
    else ms.push('昨晚平安夜');
    if(poison!==null){np[poison]={...np[poison],alive:false};ms.push(`${np[poison].name}(${poison+1}号${rd?'·'+RM[np[poison].role]:''})昨晚被毒杀`);if(!deadIds.includes(poison))deadIds.push(poison);}
    setPlayersSync(np);const rm=ms.join('；');setNightResultMsg(rm);addLog(rm);
    R.current.lastDead=deadIds;setLastDeadIds(deadIds);
    addGameHistory(`[夜晚结果] ${rm}`);
    const w=checkWin(np);if(w){setGameResult(w);setPhase('gameOver');return;}
    const mc=getModeConfig();
    if(mc.roles.includes('hunter')){
      const dh=np.find(p=>p.role==='hunter'&&!p.alive&&deadIds.includes(p.id));
      if(dh){
        if(poisonedIds.has(dh.id)){addLog(`${dh.name}(猎人)被毒杀，无法开枪`);}
        else{
          if(R.current.apiAutoMode&&!dh.isHuman&&R.current.apiConfigs[dh.id]){
            (async()=>{
              try{
                const filteredGH=filterGameHistoryForPlayer(R.current.gameHistory,dh,np);
                const prompt=plainHunterPrompt(dh,np,{round:R.current.round,gh:filteredGH,settings:getGameSettings()});
                const resp=await callAI(dh.id,prompt,runId);
                if(!isRunActive(runId))return;
                const pa=parsePlainAction(resp);
                if(pa?.action==='shoot'&&pa.target!==null&&typeof pa.target==='number'){
                  np[pa.target]={...np[pa.target],alive:false};
                  addLog(`🏹 ${dh.name}开枪→${np[pa.target].name}`);addGameHistory(`[猎人开枪] ${dh.name}→${np[pa.target].name}`);
                  setPlayersSync([...np]);
                  const w2=checkWin(np);if(w2){setGameResult(w2);setPhase('gameOver');return;}
                }else{addLog(`${dh.name}(猎人)不开枪`);}
                proceedToDay(rm,runId);
              }catch(err){
                if(isAbortError(err)||!isRunActive(runId))return;
                addLog(`猎人API错误: ${err.message}`);proceedToDay(rm,runId);
              }
            })();
            return;
          }else{
            setHunterShotPending(dh.id);setHunterShotContext('night');setPhase('hunterShot');setPromptText('');setHumanAction(null);setResponseText('');return;
          }
        }
      }
    }
    proceedToDay(rm,runId);
  };

  const proceedToDay=(rm,runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    const deadIds=R.current.lastDead;
    const canNightLW=R.current.enableLW&&R.current.allowNightLW&&(!R.current.onlyFirstNightLW||R.current.round===1);
    if(deadIds.length>0&&canNightLW){
      if(R.current.apiAutoMode){
        const aiDead=deadIds.filter(id=>{const p=R.current.players[id];return !p.isHuman&&R.current.apiConfigs[p.id];});
        const humanDead=deadIds.filter(id=>R.current.players[id].isHuman);
        const afterAllLastWords=()=>{if(!isRunActive(runId))return;enterAnnounce(runId);};
        const afterAIDone=()=>{
          if(!isRunActive(runId))return;
          if(humanDead.length>0){
            startLastWordsPhase(humanDead,'night',afterAllLastWords);
          }else{
            afterAllLastWords();
          }
        };
        if(aiDead.length>0){
          (async()=>{
            const ps=R.current.players;
            for(const id of aiDead){
              const p=ps[id];
              try{
                const filteredGH=filterGameHistoryForPlayer(R.current.gameHistory,p,ps);
                const prompt=plainLastWordsPrompt(p,ps,{round:R.current.round,gh:filteredGH,wordLimit:R.current.wordLimit?R.current.wordLimitNum:0,wordMode:R.current.wordLimitMode,settings:getGameSettings()});
                const resp=await callAI(p.id,prompt,runId);
                if(!isRunActive(runId))return;
                const text=parsePlainSpeech(resp);
                if(text){
                  R.current.lastWords=[...R.current.lastWords,{playerId:id,name:p.name,text,context:'night',round:R.current.round}];
                  setLastWordsList([...R.current.lastWords]);
                  addLog(`📜 ${p.name}遗言: ${text.substring(0,60)}`);
                  addGameHistory(`[遗言] ${p.name}: ${text}`);
                }
              }catch(err){
                if(isAbortError(err)||!isRunActive(runId))return;
                addLog(`遗言API错误: ${err.message}`);
              }
            }
            afterAIDone();
          })();
        }else{
          afterAIDone();
        }
        return;
      }
      startLastWordsPhase(deadIds,'night',()=>{if(!isRunActive(runId))return;enterAnnounce(runId);});
      return;
    }
    enterAnnounce(runId);
  };

  const enterAnnounce=(runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    R.current.precomputedSpeechOrder=computeSpeechOrder(R.current.players,R.current.round);
    setPhase('day');setStep('announce');setPromptText('');
  };
  const startSpeechesAPI=(runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    setStep('speech');setSpeeches([]);setApiStatus({});
    const ids=R.current.precomputedSpeechOrder||computeSpeechOrder(R.current.players,R.current.round);
    setStepQueue(ids);setQIdx(0);setResponseText('');
    addGameHistory(`
===== 第${R.current.round}轮白天 =====`);
    addGameHistory(`[昨晚结果] ${nightResultMsg}`);
    processSpeechAPI(ids,0,[],runId);
  };

  const processSpeechAPI=(ids,idx,spArr,runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    if(idx>=ids.length){
      setSpeeches(spArr);
      addGameHistory(`[发言] ${spArr.map(s=>`${s.name}: ${s.text}`).join('\n')}`);
      startVotingAPI(spArr,runId);
      return;
    }
    const pid=ids[idx];const p=R.current.players[pid];
    setQIdx(idx);

    if(p.isHuman){
      setPromptText('');setHumanAction('speech');setResponseText('');
      R.current.speechCallback={ids,idx,spArr,runId};
      return;
    }

    if(R.current.apiAutoMode&&R.current.apiConfigs[p.id]){
      setApiStatus(prev=>({...prev,[p.id]:'speaking'}));
      (async()=>{
        try{
          const filteredGH=filterGameHistoryForPlayer(R.current.gameHistory,p,R.current.players);
          const ctx={mc:getModeConfig(),round:R.current.round,nightResult:`昨晚: ${nightResultMsg}`,speeches:spArr,seerHistory:R.current.seerHistory,gh:filteredGH,wordLimit:R.current.wordLimit?R.current.wordLimitNum:0,wordMode:R.current.wordLimitMode,settings:getGameSettings()};
          const prompt=plainSpeechPrompt(p,R.current.players,ctx);
          const resp=await callAI(p.id,prompt,runId);
          if(!isRunActive(runId))return;
          const text=parsePlainSpeech(resp);
          const newSp=[...spArr,{id:pid,name:p.name,text}];
          setSpeeches(newSp);
          addLog(`💬 ${p.name}: ${text.substring(0,80)}...`);
          setApiStatus(prev=>({...prev,[p.id]:'done'}));
          processSpeechAPI(ids,idx+1,newSp,runId);
        }catch(err){
          if(isAbortError(err)||!isRunActive(runId))return;
          const newSp=[...spArr,{id:pid,name:p.name,text:'(API错误)'}];
          setSpeeches(newSp);
          addLog(`❌ ${p.name} 发言错误: ${err.message}`);
          setApiStatus(prev=>({...prev,[p.id]:'error'}));
          processSpeechAPI(ids,idx+1,newSp,runId);
        }
      })();
      return;
    }

    const dayCtx={round:R.current.round,seerHistory:R.current.seerHistory,nightResult:`[昨晚结果] ${nightResultMsg}`,speeches:spArr,gameLog:'',revealDeadIdentity:R.current.revealDead,voteHistory:R.current.voteHistory,lastWords:[],wordLimitEnabled:R.current.wordLimit,wordLimitNum:R.current.wordLimitNum,wordLimitMode:R.current.wordLimitMode,personalityHardcore:personalityHardcore,settings:getGameSettings()};
    setPromptText(enhancePrompt(makeDayPrompt(enc,p,R.current.players,dayCtx,'speech')));
    setHumanAction(null);
    R.current.speechCallback={ids,idx,spArr,runId};
  };

  const submitSpeech=(text)=>{
    const cb=R.current.speechCallback;if(!cb)return;
    const{ids,idx,spArr,runId}=cb;
    if(runId!==undefined&&!isRunActive(runId))return;
    const pid=ids[idx];const p=R.current.players[pid];
    const newSp=[...spArr,{id:pid,name:p.name,text}];
    setSpeeches(newSp);setResponseText('');
    R.current.speechCallback=null;
    processSpeechAPI(ids,idx+1,newSp,runId);
  };

  /* ===== VOTING (API auto) ===== */
  const startVotingAPI=(sp,runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    if(!R.current.apiAutoMode){
      setStep('vote');setVotes({});setVoteOrder([]);setVotingActive(true);setSelectedVoter(null);setSelectedVoteTarget(null);setSpeeches(sp);setResponseText('');setPromptText('');setHumanAction(null);
      return;
    }

    setStep('vote');setVotes({});setVoteOrder([]);
    const ps=R.current.players;
    const alive=ps.filter(p=>p.alive&&p.canVote!==false);
    const aiVoters=alive.filter(p=>!p.isHuman&&R.current.apiConfigs[p.id]);
    const humanVoters=alive.filter(p=>p.isHuman);

    R.current.pendingVotes={};
    R.current.pendingVoteHumans=humanVoters.map(p=>p.id);
    R.current.aiVoteDone=false;
    setVotingActive(true);setSelectedVoter(null);setSelectedVoteTarget(null);

    let aiDone=0;

    const tryResolve=()=>{
      if(!isRunActive(runId))return;
      if(!R.current.aiVoteDone)return;
      if(R.current.pendingVoteHumans.length>0)return;
      resolveVoteResult({...R.current.pendingVotes},runId);
    };

    for(const p of aiVoters){
      (async()=>{
        try{
          const filteredGH=filterGameHistoryForPlayer(R.current.gameHistory,p,ps);
          const ctx={mc:getModeConfig(),round:R.current.round,nightResult:`昨晚: ${nightResultMsg}`,speeches:sp,seerHistory:R.current.seerHistory,gh:filteredGH,settings:getGameSettings()};
          const prompt=plainVotePrompt(p,ps,ctx);
          const resp=await callAI(p.id,prompt,runId);
          if(!isRunActive(runId))return;
          const pa=parsePlainAction(resp);
          if(pa){
            if(pa.target==='abstain'||pa.action==='skip'){R.current.pendingVotes[p.id]='abstain';addLog(`🗳️ ${p.name} 弃票`);}
            else if(pa.target!==null&&typeof pa.target==='number'){R.current.pendingVotes[p.id]=pa.target;addLog(`🗳️ ${p.name}→${ps[pa.target].name}`);}
            else{R.current.pendingVotes[p.id]='abstain';addLog(`${p.name} 投票解析失败`);}
          }else{R.current.pendingVotes[p.id]='abstain';}
        }catch(err){
          if(isAbortError(err)||!isRunActive(runId))return;
          R.current.pendingVotes[p.id]='abstain';addLog(`${p.name} 投票API错误`);
        }
        aiDone++;
        setVotes({...R.current.pendingVotes});setVoteOrder(Object.keys(R.current.pendingVotes).map(Number));
        if(aiDone>=aiVoters.length){R.current.aiVoteDone=true;tryResolve();}
      })();
    }
    if(aiVoters.length===0){R.current.aiVoteDone=true;tryResolve();}
  };

  const resolveVoteResult=(v,runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    setVotingActive(false);
    const cc={};Object.entries(v).forEach(([,t])=>{if(t!=='abstain')cc[t]=(cc[t]||0)+1;});
    const np=[...R.current.players];let msg;const voteDeadIds=[];
    if(Object.keys(cc).length===0)msg='投票结果：全员弃票，无人出局';
    else{
      const mx=Math.max(...Object.values(cc));const ts=Object.entries(cc).filter(([,c])=>c===mx).map(([k])=>+k);
      if(ts.length>1)msg=`投票平票(${ts.map(t=>`${t+1}号`).join('vs')}各${mx}票)，无人出局`;
      else{
        const t=ts[0];
        if(np[t].role==='idiot'&&!np[t].idiotRevealed){np[t]={...np[t],alive:true,idiotRevealed:true,canVote:false};msg=`${np[t].name}(${t+1}号)被投出(${mx}票)，翻牌白痴免死`;}
        else{np[t]={...np[t],alive:false};msg=`${np[t].name}(${t+1}号)被投出(${mx}票)${R.current.revealDead?'，'+RM[np[t].role]:''}`;voteDeadIds.push(t);}
      }
    }
    setPlayersSync(np);addLog(msg);
    addGameHistory(`[投票结果] ${msg}`);
    addGameHistory(`[投票详情] ${Object.entries(v).map(([f,t])=>t==='abstain'?`${np[f].name}→弃票`:`${np[+f].name}→${np[+t].name}`).join('、')}`);
    const vhEntry={round:R.current.round,votes:{...v},details:Object.entries(v).map(([f,t])=>t==='abstain'?`${np[+f].name}→弃票`:`${np[+f].name}→${np[+t].name}`).join(', ')};
    R.current.voteHistory=[...R.current.voteHistory,vhEntry];setDayVoteHistory([...R.current.voteHistory]);
    R.current.lastDead=voteDeadIds;setLastDeadIds(voteDeadIds);
    const w=checkWin(np);if(w){setGameResult(w);setPhase('gameOver');return;}

    if(voteDeadIds.length===1&&getModeConfig().roles.includes('hunter')&&np[voteDeadIds[0]].role==='hunter'){
      const hid=voteDeadIds[0];
      if(R.current.apiAutoMode&&!np[hid].isHuman&&R.current.apiConfigs[hid]){
        (async()=>{
          try{
            const filteredGH=filterGameHistoryForPlayer(R.current.gameHistory,np[hid],np);
            const prompt=plainHunterPrompt(np[hid],np,{round:R.current.round,gh:filteredGH,settings:getGameSettings()});
            const resp=await callAI(hid,prompt,runId);if(!isRunActive(runId))return;const pa=parsePlainAction(resp);
            if(pa?.action==='shoot'&&pa.target!==null&&typeof pa.target==='number'){
              np[pa.target]={...np[pa.target],alive:false};setPlayersSync([...np]);
              addLog(`🏹 ${np[hid].name}→${np[pa.target].name}`);addGameHistory(`[猎人开枪] ${np[hid].name}→${np[pa.target].name}`);
              const w2=checkWin(np);if(w2){setGameResult(w2);setPhase('gameOver');return;}
            }
          }catch(err){
            if(isAbortError(err)||!isRunActive(runId))return;
            addLog(`猎人API错误`);
          }
          showDayResult(msg,runId);
        })();return;
      }
      setHunterShotPending(hid);setHunterShotContext('vote');setPhase('hunterShot');setPromptText(msg);setHumanAction(null);return;
    }
    showDayResult(msg,runId);
  };

  const showDayResult=(msg,runId=R.current.apiRunId)=>{
    if(!isRunActive(runId))return;
    const deadIds=R.current.lastDead;
    if(deadIds.length>0&&R.current.enableLW&&R.current.apiAutoMode){
      const aiDead=deadIds.filter(id=>{const p=R.current.players[id];return !p.isHuman&&R.current.apiConfigs[p.id];});
      const humanDead=deadIds.filter(id=>R.current.players[id].isHuman);
      const afterAllLastWords=()=>{if(!isRunActive(runId))return;setPhase('dayResult');setPromptText(msg);};
      const afterAIDone=()=>{
        if(!isRunActive(runId))return;
        if(humanDead.length>0){
          startLastWordsPhase(humanDead,'vote',afterAllLastWords);
        }else{
          afterAllLastWords();
        }
      };
      if(aiDead.length>0){
        (async()=>{
          const ps=R.current.players;
          for(const id of aiDead){
            const p=ps[id];
            try{
              const filteredGH=filterGameHistoryForPlayer(R.current.gameHistory,p,ps);
              const prompt=plainLastWordsPrompt(p,ps,{round:R.current.round,gh:filteredGH,wordLimit:R.current.wordLimit?R.current.wordLimitNum:0,wordMode:R.current.wordLimitMode,settings:getGameSettings()});
              const resp=await callAI(p.id,prompt,runId);
              if(!isRunActive(runId))return;
              const text=parsePlainSpeech(resp);
              if(text){
                R.current.lastWords=[...R.current.lastWords,{playerId:id,name:p.name,text,context:'vote',round:R.current.round}];
                setLastWordsList([...R.current.lastWords]);
                addLog(`📜 ${p.name}遗言: ${text.substring(0,60)}`);
                addGameHistory(`[遗言] ${p.name}: ${text}`);
              }
            }catch(err){
              if(isAbortError(err)||!isRunActive(runId))return;
              addLog(`遗言API错误: ${err.message}`);
            }
          }
          afterAIDone();
        })();
      }else{
        afterAIDone();
      }
      return;
    }
    setPhase('dayResult');setPromptText(msg);
  };

  const nextRound=()=>{const nr=R.current.round+1;setRoundSync(nr);if(R.current.apiAutoMode)startNightAPI(R.current.players,nr);else _startNight(R.current.players,enc,nr);};

  /* ===== HUMAN NIGHT ACTIONS (for API mode) ===== */
  const confirmNightTransition=()=>{setNightHumanState('action');setHumanAction(null);};

  const processHumanNightActionValue=(value)=>{
    const sub=step;const hid=nightHumanQueue[nightHumanQIdx];const hp=R.current.players[hid];
    if(!hp)return;
    if((sub==='wolf'||sub==='werewolf'||sub==='wolfSeer')&&hp.role==='werewolf'){
      if(typeof value!=='number'){alert('请选择目标');return;}
      const nw={...R.current.wolfVotes,[hp.id]:value};setWolfVotesSync(nw);
      advanceNightHuman();
    }else if((sub==='seer'||sub==='wolfSeer')&&hp.role==='seer'){
      if(typeof value!=='number'){alert('请选择目标');return;}
      const iw=R.current.players[value].role==='werewolf';
      setSeerHistorySync([...R.current.seerHistory,{target:value,isWolf:iw}]);
      setSeerCheckResult({target:value,isWolf:iw});setNightHumanState('seerResult');
    }else if(sub==='witch'&&hp.role==='witch'){
      if(value==='save'){R.current.witchSaved=true;setWitchHasSaveSync(false);}
      else if(typeof value==='number'){R.current.witchPoisonTarget=value;setWitchHasPoisonSync(false);}
      advanceNightHuman();
    }
  };

  const processHumanNightAction=()=>{processHumanNightActionValue(humanAction);};

  const advanceNightHuman=()=>{
    const next=nightHumanQIdx+1;
    if(next>=nightHumanQueue.length){
      setNightHumanQIdx(next);setNightHumanState(null);setHumanAction(null);setSeerCheckResult(null);
      markHumanDone();
    }else{
      setNightHumanQIdx(next);setNightHumanState(roomMode?'action':'transition');setHumanAction(null);setSeerCheckResult(null);
    }
  };

  // Helper: set up night human queue, auto-skipping for single human
  // Returns true if there are pending human actions, false if all skipped/none
  const setupNightHumanPhase=(ps,sub)=>{
    const allHumans=ps.filter(p=>p.isHuman&&p.alive).sort((a,b)=>a.id-b.id);
    setNightHumanQueue(allHumans.map(p=>p.id));
    setSeerCheckResult(null);setHumanAction(null);
    if(allHumans.length===0){
      setNightHumanQIdx(-1);setNightHumanState(null);
      return false;
    }
    setNightHumanQIdx(0);
    if(allHumans.length===1){
      const hp=allHumans[0];
      const isActive=(sub==='wolfSeer'||sub==='wolf'||sub==='werewolf')&&hp.role==='werewolf'||(sub==='wolfSeer'||sub==='seer')&&hp.role==='seer'||sub==='witch'&&hp.role==='witch';
      if(isActive){
        setNightHumanState('action');
        if(R.current.round===1&&R.current.apiAutoMode) R.current.firstNightRoleShown=true;
        return true;
      }else{
        if(R.current.round===1&&R.current.apiAutoMode&&!R.current.firstNightRoleShown){
          R.current.firstNightRoleShown=true;
          setNightHumanState('action');
          return true; // need to show role info
        }else{
          setNightHumanQIdx(1);setNightHumanState(null);
          return false; // fully skipped
        }
      }
    }else{
      setNightHumanState(roomMode?'action':'transition');
      return true;
    }
  };

  /* ===== MANUAL MODE NIGHT ===== */
  const _startNight=(ps,e,r)=>{
    setPhase('night');setWolfVotesSync({});setNightKillSync(null);
    R.current.witchSaved=false;R.current.witchPoisonTarget=null;
    setStep('werewolf');setHumanAction(null);setResponseText('');setShowTransition(false);
    setNightHumanQueue([]);setNightHumanQIdx(-1);setNightHumanState(null);setSeerCheckResult(null);
    _initManualSubPhase('werewolf',ps,e,r);
  };

  const _initManualSubPhase=(sub,ps,e,r)=>{
    setStep(sub);setExpandedPlayerId(null);setHumanAction(null);setResponseText('');
    const ctx={round:r,seerHistory:R.current.seerHistory,witchHasSave:R.current.witchSave,witchHasPoison:R.current.witchPoison,wolfVotes:R.current.wolfVotes,nightKill:R.current.nightKill,revealDeadIdentity:R.current.revealDead,voteHistory:R.current.voteHistory,lastWords:[],settings:getGameSettings()};
    const prompts={};const alive=ps.filter(p=>p.alive);const si=sub==='werewolf'?1:sub==='seer'?2:3;
    for(const p of alive){
      if(p.isHuman)continue;
      const active=(sub==='werewolf'&&p.role==='werewolf')||(sub==='seer'&&p.role==='seer')||(sub==='witch'&&p.role==='witch');
      if(active){if(sub==='werewolf')prompts[p.id]=enhancePrompt(makeNightWolf(e,p,ps,ctx));else if(sub==='seer')prompts[p.id]=enhancePrompt(makeNightSeer(e,p,ps,ctx));else prompts[p.id]=enhancePrompt(makeNightWitch(e,p,ps,ctx));}
      else prompts[p.id]=enhancePrompt(makeNightSleep(e,p,ps,ctx,si));
    }
    setNightPrompts(prompts);setNightResponseMap({});
    const humanQueue=ps.filter(p=>p.isHuman&&p.alive).map(p=>p.id);
    setNightHumanQueue(humanQueue);
    if(humanQueue.length>0){setNightHumanQIdx(0);setNightHumanState('transition');}
    else{setNightHumanQIdx(-1);setNightHumanState(null);}
  };

  const processManualNightResponses=()=>{
    const sub=step;const ps=R.current.players;const e=enc;const r=R.current.round;
    const responses={...nightResponseMap};const allIds=Object.keys(nightPrompts).map(Number);
    const activeIds=allIds.filter(id=>(sub==='werewolf'&&ps[id].role==='werewolf')||(sub==='seer'&&ps[id].role==='seer')||(sub==='witch'&&ps[id].role==='witch'));
    for(const id of allIds){if(!responses[id]?.trim()){alert(`请填写 ${ps[id].name} 回复`);return;}}
    if(sub==='werewolf'){for(const id of activeIds){const pa=parseAction(responses[id],e);if(!pa||pa.target===null){alert(`无法解析 ${ps[id].name}`);return;}setWolfVotesSync({...R.current.wolfVotes,[id]:pa.target});}}
    else if(sub==='seer'){for(const id of activeIds){const pa=parseAction(responses[id],e);if(!pa||pa.target===null){alert(`无法解析 ${ps[id].name}`);return;}const iw=ps[pa.target].role==='werewolf';setSeerHistorySync([...R.current.seerHistory,{target:pa.target,isWolf:iw}]);}}
    else if(sub==='witch'){for(const id of activeIds){const pa=parseAction(responses[id],e);if(pa){if(pa.action==='save'){R.current.witchSaved=true;setWitchHasSaveSync(false);}else if(pa.action==='poison'&&pa.target!==null){R.current.witchPoisonTarget=pa.target;setWitchHasPoisonSync(false);}}}}
    // Advance
    if(sub==='werewolf'){
      const wv=R.current.wolfVotes;const cc={};Object.values(wv).forEach(t=>{cc[t]=(cc[t]||0)+1;});
      let kill=null;if(Object.keys(cc).length>0){const mx=Math.max(...Object.values(cc));const ts=Object.entries(cc).filter(([,v])=>v===mx).map(([k])=>+k);kill=ts[0];}
      setNightKillSync(kill);
      if(ps.some(p=>p.alive&&p.role==='seer'))_initManualSubPhase('seer',ps,e,r);
      else if(ps.some(p=>p.alive&&p.role==='witch'))_initManualSubPhase('witch',ps,e,r);
      else resolveNight(kill,false,null);
    }else if(sub==='seer'){
      if(ps.some(p=>p.alive&&p.role==='witch'))_initManualSubPhase('witch',ps,e,r);
      else resolveNight(R.current.nightKill,false,null);
    }else if(sub==='witch'){
      resolveNight(R.current.nightKill,R.current.witchSaved,R.current.witchPoisonTarget);
    }
  };

  /* ===== LAST WORDS ===== */
  const startLastWordsPhase=(deadIds,context,afterCb)=>{
    if(!R.current.enableLW){afterCb();return;}
    if(context==='night'&&(!R.current.allowNightLW||(R.current.onlyFirstNightLW&&R.current.round!==1))){afterCb();return;}
    const valid=deadIds.filter(id=>R.current.players[id]&&!R.current.players[id].alive);
    if(!valid.length){afterCb();return;}
    setPhase('lastWords');setLwQueue(valid);setLwQIdx(0);setLwInput('');setLwResponseText('');setLwContext(context);setLwAfterCallback(()=>afterCb);
    const p=R.current.players[valid[0]];
    if(!p.isHuman)setLwPromptText(enhancePrompt(makeLastWordsPrompt(enc,p,R.current.players,{round:R.current.round})));else setLwPromptText('');
  };

  const confirmLastWords=text=>{
    const pid=lwQueue[lwQIdx];const p=R.current.players[pid];const lwText=text||'(无遗言)';
    if(lwText!=='(无遗言)'){R.current.lastWords=[...R.current.lastWords,{playerId:pid,name:p.name,text:lwText,context:lwContext,round:R.current.round}];setLastWordsList([...R.current.lastWords]);addLog(`${p.name}遗言: ${lwText}`);}
    const next=lwQIdx+1;
    if(next>=lwQueue.length){const cb=lwAfterCallback;setPhase('_lwDone');setLwQueue([]);setLwQIdx(0);if(cb)cb();}
    else{setLwQIdx(next);setLwInput('');setLwResponseText('');const np=R.current.players[lwQueue[next]];if(!np.isHuman)setLwPromptText(enhancePrompt(makeLastWordsPrompt(enc,np,R.current.players,{round:R.current.round})));else setLwPromptText('');}
  };

  /* ===== HUNTER SHOT ===== */
  const processHunterShot=targetId=>{
    const hid=hunterShotPending;const hunter=R.current.players[hid];const np=[...R.current.players];let msg;
    if(targetId===null){msg=`${hunter.name}(猎人)不开枪`;}
    else{np[targetId]={...np[targetId],alive:false};msg=`${hunter.name}(猎人)→${np[targetId].name}${R.current.revealDead?'('+RM[np[targetId].role]+')':''}`;}
    setPlayersSync(np);addLog(msg);setHunterShotPending(null);
    const w=checkWin(np);if(w){setGameResult(w);setPhase('gameOver');return;}
    if(hunterShotContext==='night'){setNightResultMsg(prev=>prev+`；${msg}`);proceedToDay(nightResultMsg+`；${msg}`);}
    else showDayResult(msg);
  };

  const computeSpeechOrder=(ps,r)=>{
    const alive=ps.filter(p=>p.alive).map(p=>p.id).sort((a,b)=>a-b);
    if(!alive.length)return[];
    const m=R.current.speechOrder;
    if(m===1){
      // 随机顺序: 随机选一个存活玩家开始，然后按座位号顺序
      const s=0|Math.random()*alive.length;
      return[...alive.slice(s),...alive.slice(0,s)];
    }
    if(m===2){
      // 1号开始: 按座位号从小到大
      return alive;
    }
    if(m===3){
      // 标准: 平安夜随机开始，非平安夜从最小死者的下一位开始
      const d=R.current.lastDead;
      if(!d.length){
        // 平安夜 → 随机选一个开始
        const s=0|Math.random()*alive.length;
        return[...alive.slice(s),...alive.slice(0,s)];
      }
      // 非平安夜 → 从最小死者号+1开始
      const ref=Math.min(...d);
      let startId=alive.find(id=>id>ref);
      if(startId===undefined)startId=alive[0]; // 绕回
      const idx=alive.indexOf(startId);
      return[...alive.slice(idx),...alive.slice(0,idx)];
    }
    return alive;
  };

  /* ===== GAME START ===== */
  const startGame=()=>{
    abortAllApiTasks('开始新游戏，停止旧局API');
    const runId=R.current.apiRunId;
    const mc=getModeConfig();
    const base=players.length===mc.roles.length?players:syncPlayersCount(players,mc.roles.length);
    let np;
    if(adminMode&&adminCustomRoles){
      const neededCounts={};mc.roles.forEach(r=>{neededCounts[r]=(neededCounts[r]||0)+1;});
      const usedCounts={};
      for(let i=0;i<base.length;i++){const r=customRoleAssign[i];if(r)usedCounts[r]=(usedCounts[r]||0)+1;}
      const remaining=[];Object.entries(neededCounts).forEach(([r,n])=>{const left=Math.max(0,n-(usedCounts[r]||0));for(let j=0;j<left;j++)remaining.push(r);});
      const shuffled=shuffle(remaining);let si=0;
      np=base.map((p,i)=>({...p,role:customRoleAssign[i]||(si<shuffled.length?shuffled[si++]:'villager'),alive:true,canVote:true,idiotRevealed:false}));
    }else{
      const roles=shuffle(mc.roles);
      np=base.map((p,i)=>({...p,role:roles[i],alive:true,canVote:true,idiotRevealed:false}));
    }
    const ne=genEnc(mc.roles.length);ne.hasHunter=mc.roles.includes('hunter');ne.hasIdiot=mc.roles.includes('idiot');
    setPlayersSync(np);setEnc(ne);setRoundSync(1);setLog([]);
    setSeerHistorySync([]);setWitchHasSaveSync(true);setWitchHasPoisonSync(true);
    setNightResultMsg('');setGameResult(null);setVotes({});setVoteOrder([]);
    setHunterShotPending(null);setHunterShotContext(null);
    R.current.witchSaved=false;R.current.witchPoisonTarget=null;
    setShowAllRoles(false);setShowAllRolesModal(false);setNightHumanQueue([]);setNightHumanQIdx(-1);setNightHumanState(null);setSeerCheckResult(null);
    R.current.lastWords=[];setLastWordsList([]);R.current.voteHistory=[];setDayVoteHistory([]);
    R.current.lastDead=[];setLastDeadIds([]);
    R.current.gameHistory=[];setGameHistory([]);
    setApiStatus({});setNightProgressPct(0);setNightProgressLabel('');
    R.current.firstNightRoleShown=false;

    R.current.apiAutoMode=apiAutoMode;R.current.apiConfigs=apiConfigs;
    R.current.enableLW=enableLastWords;R.current.allowNightLW=allowNightLastWords;R.current.onlyFirstNightLW=onlyFirstNightLW;
    R.current.revealDead=revealDeadIdentity;R.current.enhanceAI=enhanceAI;R.current.adminMode=adminMode;
    R.current.adminModeAvail=adminMode;
    R.current.wordLimit=wordLimitEnabled;R.current.wordLimitNum=wordLimitNum;R.current.wordLimitMode=wordLimitMode;
    R.current.speechOrder=speechOrderMode;R.current.personalityHardcore=personalityHardcore;

    if(apiAutoMode){
      addGameHistory(`[游戏开始] ${mc.label}`);
      addGameHistory(`[玩家] ${np.map(p=>`${p.id+1}号${p.name}(${p.isHuman?'人类':'AI'})`).join('、')}`);
    }

    const humanPlayers=np.filter(p=>p.isHuman);
    if(apiAutoMode){
      scheduleGameTask(()=>startNightAPI(np,1,runId),500,runId);
    }else if(humanPlayers.length>0){
      setPhase('roleReveal');
      const queue=np.map((_,i)=>i);
      setStepQueue(queue);setQIdx(0);
      const p=np[queue[0]];
      doTransition(p,()=>{if(p.isHuman){setPromptText('');setShowRole(roomMode&&p.id!==mySeat?null:p);}else{setPromptText(enhancePrompt(makeRolePrompt(ne,p,np,mc,getGameSettings())));setShowRole(null);}});
    }
  };

  const nextRoleReveal=()=>{
    const next=qIdx+1;setResponseText('');
    if(next>=stepQueue.length){
      if(R.current.apiAutoMode)startNightAPI(R.current.players,1);
      else _startNight(R.current.players,enc,1);
      return;
    }
    setQIdx(next);const p=R.current.players[stepQueue[next]];const mc=getModeConfig();
    doTransition(p,()=>{if(p.isHuman){setPromptText('');setShowRole(roomMode&&p.id!==mySeat?null:p);}else{setPromptText(enhancePrompt(makeRolePrompt(enc,p,R.current.players,mc,getGameSettings())));setShowRole(null);}});
  };

  /* ===== MANUAL SPEECH/VOTE ===== */
  const startSpeeches=()=>{
    if(R.current.apiAutoMode){startSpeechesAPI();return;}
    setStep('speech');setSpeeches([]);
    const ids=R.current.precomputedSpeechOrder||computeSpeechOrder(R.current.players,R.current.round);
    setStepQueue(ids);setQIdx(0);setResponseText('');
    const p=R.current.players[ids[0]];
    const dayCtx={round:R.current.round,seerHistory:R.current.seerHistory,nightResult:`[昨晚结果] ${nightResultMsg}`,speeches:[],gameLog:'',revealDeadIdentity:R.current.revealDead,voteHistory:R.current.voteHistory,lastWords:[],wordLimitEnabled:R.current.wordLimit,wordLimitNum:R.current.wordLimitNum,wordLimitMode:R.current.wordLimitMode,personalityHardcore,settings:getGameSettings()};
    if(p.isHuman){setPromptText('');setHumanAction('speech');}else{setPromptText(enhancePrompt(makeDayPrompt(enc,p,R.current.players,dayCtx,'speech')));setHumanAction(null);}
  };

  const procSpeechWithText=(overrideText)=>{
    const pid=stepQueue[qIdx];const p=R.current.players[pid];
    let text;if(p.isHuman)text=overrideText||responseText||'(未发言)';else text=parseSpeech(overrideText||responseText);
    const ns=[...speeches,{id:pid,name:p.name,text}];setSpeeches(ns);setResponseText('');
    const next=qIdx+1;if(next>=stepQueue.length){
      if(R.current.apiAutoMode)startVotingAPI(ns);
      else{setStep('vote');setVotes({});setVoteOrder([]);setVotingActive(true);setSelectedVoter(null);setSelectedVoteTarget(null);setSpeeches(ns);setResponseText('');setPromptText('');setHumanAction(null);}
      return;
    }
    setQIdx(next);const np=R.current.players[stepQueue[next]];
    const dayCtx={round:R.current.round,seerHistory:R.current.seerHistory,nightResult:`[昨晚结果] ${nightResultMsg}`,speeches:ns,gameLog:'',revealDeadIdentity:R.current.revealDead,voteHistory:R.current.voteHistory,lastWords:[],wordLimitEnabled:R.current.wordLimit,wordLimitNum:R.current.wordLimitNum,wordLimitMode:R.current.wordLimitMode,personalityHardcore,settings:getGameSettings()};
    if(np.isHuman){setPromptText('');setHumanAction('speech');}else{setPromptText(enhancePrompt(makeDayPrompt(enc,np,R.current.players,dayCtx,'speech')));setHumanAction(null);}
  };

  const procSpeech=()=>{procSpeechWithText();};

  const selectVoter=pid=>{
    if(R.current.players[pid].canVote===false)return;if(votes[pid]!==undefined&&votes[pid]!=='abstain')return;
    if(votes[pid]==='abstain'){const nv={...votes};delete nv[pid];setVotes(nv);setVoteOrder(p=>p.filter(id=>id!==pid));}
    setSelectedVoter(pid);setSelectedVoteTarget(null);setResponseText('');
    const p=R.current.players[pid];
    if(!p.isHuman){const dayCtx={round:R.current.round,seerHistory:R.current.seerHistory,nightResult:`[昨晚结果] ${nightResultMsg}`,speeches,gameLog:'',revealDeadIdentity:R.current.revealDead,voteHistory:R.current.voteHistory,lastWords:[],currentVotes:votes,settings:getGameSettings()};setPromptText(enhancePrompt(makeDayPrompt(enc,p,R.current.players,dayCtx,'vote')));}else setPromptText('');
  };

  const confirmVote=()=>{
    const pid=selectedVoter;const p=R.current.players[pid];let t;
    if(p.isHuman)t=selectedVoteTarget;
    else{if(selectedVoteTarget!==null)t=selectedVoteTarget;else{const pa=parseAction(responseText,enc);if(pa&&(pa.action==='skip'||pa.action==='sleep'))t='abstain';else t=pa?.target;}}
    if(t==='abstain'){const nv={...votes,[pid]:'abstain'};const no=[...voteOrder,pid];setVotes(nv);setVoteOrder(no);setSelectedVoter(null);setSelectedVoteTarget(null);setResponseText('');setPromptText('');addLog(`${p.name} 弃票`);const alive=R.current.players.filter(p2=>p2.alive&&p2.canVote!==false);if(no.length>=alive.length)resolveVoteResult(nv);return;}
    if(t===null||t===undefined){alert('请选择目标');return;}
    const nv={...votes,[pid]:t};const no=[...voteOrder,pid];setVotes(nv);setVoteOrder(no);setSelectedVoter(null);setSelectedVoteTarget(null);setResponseText('');setPromptText('');
    const alive=R.current.players.filter(p2=>p2.alive&&p2.canVote!==false);if(no.length>=alive.length)resolveVoteResult(nv);
  };

  const endVotingEarly=()=>{
    const alive=R.current.players.filter(p=>p.alive&&p.canVote!==false).map(p=>p.id);
    const fv={...votes};for(const id of alive){if(fv[id]===undefined)fv[id]='abstain';}
    resolveVoteResult(fv);
  };

  // Human vote in API mode (simultaneous with AI voting)
  const confirmHumanVoteAPI=()=>{
    if(selectedVoteTarget===null){alert('请选择');return;}
    const pid=selectedVoter;
    R.current.pendingVotes[pid]=selectedVoteTarget;
    const remaining=(R.current.pendingVoteHumans||[]).filter(id=>id!==pid);
    R.current.pendingVoteHumans=remaining;
    addLog(`🗳️ ${players[pid].name}${selectedVoteTarget==='abstain'?'弃票':'→'+players[selectedVoteTarget]?.name}`);
    setVotes({...R.current.pendingVotes});setVoteOrder(Object.keys(R.current.pendingVotes).map(Number));
    setSelectedVoter(null);setSelectedVoteTarget(null);
    // Resolve only when both AI and humans are all done
    if(remaining.length===0&&R.current.aiVoteDone)resolveVoteResult({...R.current.pendingVotes});
  };

  const applyRemoteVote=(action)=>{
    const seatId=Number(action?.seatId);
    const target=action?.target;
    if(R.current.apiAutoMode){
      const canVote=phase==='day'&&step==='vote'&&votingActive&&R.current.players[seatId]?.alive&&R.current.players[seatId]?.canVote!==false&&R.current.pendingVotes[seatId]===undefined;
      if(!canVote)return;
      R.current.pendingVotes[seatId]=target;
      const remaining=(R.current.pendingVoteHumans||[]).filter(id=>id!==seatId);
      R.current.pendingVoteHumans=remaining;
      addLog(`🗳️ ${players[seatId].name}${target==='abstain'?'弃票':'→'+players[target]?.name}`);
      setVotes({...R.current.pendingVotes});setVoteOrder(Object.keys(R.current.pendingVotes).map(Number));
      if(remaining.length===0&&R.current.aiVoteDone)resolveVoteResult({...R.current.pendingVotes});
      return;
    }
    if(phase!=='day'||step!=='vote'||!votingActive||selectedVoter!==seatId)return;
    const nv={...votes,[seatId]:target};
    const no=voteOrder.includes(seatId)?voteOrder:[...voteOrder,seatId];
    setVotes(nv);setVoteOrder(no);setSelectedVoter(null);setSelectedVoteTarget(null);setResponseText('');setPromptText('');
    const alive=R.current.players.filter(p=>p.alive&&p.canVote!==false);if(no.length>=alive.length)resolveVoteResult(nv);
  };

  remoteActionRouterRef.current=(action)=>{
    if(!action)return;
    const seatId=Number(action.seatId);
    if(action.kind==='roleRevealConfirm'){if(phase==='roleReveal'&&stepQueue[qIdx]===seatId)nextRoleReveal();return;}
    if(action.kind==='nightSubmit'){if(phase==='night'&&nightHumanQueue[nightHumanQIdx]===seatId)processHumanNightActionValue(action.value);return;}
    if(action.kind==='seerResultConfirm'){if(phase==='night'&&nightHumanState==='seerResult'&&nightHumanQueue[nightHumanQIdx]===seatId)advanceNightHuman();return;}
    if(action.kind==='speechSubmit'){if(phase==='day'&&step==='speech'&&stepQueue[qIdx]===seatId){if(R.current.apiAutoMode&&R.current.speechCallback)submitSpeech(action.text||'(未发言)');else procSpeechWithText(action.text||'(未发言)');}return;}
    if(action.kind==='voteSubmit'){applyRemoteVote(action);return;}
    if(action.kind==='hunterShotSubmit'){if(phase==='hunterShot'&&hunterShotPending===seatId)processHunterShot(action.target===null||action.target==='skip'?null:action.target);return;}
    if(action.kind==='lastWordsSubmit'){if(phase==='lastWords'&&lwQueue[lwQIdx]===seatId)confirmLastWords(action.text||null);return;}
  };

  const resetGame=()=>{
    abortAllApiTasks('游戏已重置，停止旧局API');
    setPhase('setup');setPlayersSync(ps=>ps.map(p=>({...p,role:null,alive:true,canVote:true,idiotRevealed:false})));setEnc(null);setRoundSync(1);setLog([]);
    setGameResult(null);setNightResultMsg('');setSeerHistorySync([]);setWitchHasSaveSync(true);setWitchHasPoisonSync(true);setShowTransition(false);setTransitionTarget(null);setTransitionCallback(null);
    setVotes({});setVoteOrder([]);setVotingActive(false);setHunterShotPending(null);
    R.current.witchSaved=false;R.current.witchPoisonTarget=null;
    setNightPrompts({});setNightResponseMap({});setExpandedPlayerId(null);setPromptText('');setResponseText('');setStep('');setStepQueue([]);setQIdx(0);
    setShowAllRoles(false);setShowAllRolesModal(false);setNightHumanQueue([]);setNightHumanQIdx(-1);setNightHumanState(null);setSeerCheckResult(null);
    R.current.lastWords=[];setLastWordsList([]);R.current.voteHistory=[];setDayVoteHistory([]);
    setLwQueue([]);setLwQIdx(0);setLwInput('');setLwPromptText('');setLwResponseText('');setLwAfterCallback(null);setLwContext(null);R.current.lastDead=[];setLastDeadIds([]);
    R.current.gameHistory=[];setGameHistory([]);setApiStatus({});setNightProgressPct(0);setNightProgressLabel('');
    R.current.subPhaseCallback=null;R.current.speechCallback=null;R.current.adminModeAvail=false;R.current._wolfSeerMarkDone=null;R.current.firstNightRoleShown=false;
  };

  /* ===== API CONFIG MODAL ===== */
  const ApiConfigModal=()=>{
    if(apiConfigModal===null)return null;
    const pid=apiConfigModal;const p=players[pid];
    const cfg=apiConfigs[pid]||{apiKey:'',apiUrl:'',maxTokens:65536,model:''};
    const [lc,setLc]=useState(cfg);
    return(
      <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={()=>setApiConfigModal(null)}>
        <div className="bg-gray-900 border-2 border-cyan-500 rounded-2xl p-5 max-w-md w-full" onClick={e=>e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4"><h2 className="font-bold text-cyan-400">⚙️ API - {p.name}({pid+1}号)</h2><button onClick={()=>setApiConfigModal(null)} className="text-gray-400 hover:text-white text-lg">✕</button></div>
          <div className="space-y-3">
            <div><label className="text-xs text-gray-400 block mb-1">API地址 (完整URL)</label><input className="w-full bg-gray-950 text-gray-200 text-sm rounded px-3 py-2 border border-gray-700 focus:border-cyan-500 focus:outline-none" placeholder="https://api.openai.com/v1/chat/completions" value={lc.apiUrl} onChange={e=>setLc({...lc,apiUrl:e.target.value})}/></div>
            <div><label className="text-xs text-gray-400 block mb-1">API密钥</label><input type="password" className="w-full bg-gray-950 text-gray-200 text-sm rounded px-3 py-2 border border-gray-700 focus:border-cyan-500 focus:outline-none" placeholder="sk-..." value={lc.apiKey} onChange={e=>setLc({...lc,apiKey:e.target.value})}/></div>
            <div><label className="text-xs text-gray-400 block mb-1">模型</label><input className="w-full bg-gray-950 text-gray-200 text-sm rounded px-3 py-2 border border-gray-700 focus:border-cyan-500 focus:outline-none" placeholder="gpt-4o / claude-sonnet-4-20250514..." value={lc.model} onChange={e=>setLc({...lc,model:e.target.value})}/></div>
            <div><label className="text-xs text-gray-400 block mb-1">最大Token</label><input type="number" className="w-full bg-gray-950 text-gray-200 text-sm rounded px-3 py-2 border border-gray-700 focus:border-cyan-500 focus:outline-none" value={lc.maxTokens} onChange={e=>setLc({...lc,maxTokens:parseInt(e.target.value)||65536})}/></div>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={()=>{const nc={...apiConfigs,[pid]:lc};saveApiConfigs(nc);setApiConfigModal(null);}} className="bg-cyan-600 hover:bg-cyan-500 text-white font-bold px-4 py-2 rounded-xl flex-1">保存</button>
            <button onClick={()=>setApiConfigModal(null)} className="bg-gray-700 px-4 py-2 rounded-xl">取消</button>
          </div>
          <button onClick={()=>{const nc={...apiConfigs};players.forEach(pp=>{if(!pp.isHuman)nc[pp.id]={...lc};});saveApiConfigs(nc);setApiConfigModal(null);}} className="w-full text-xs text-cyan-400 hover:text-cyan-300 py-2 mt-2">📋 应用到所有AI玩家</button>
        </div>
      </div>
    );
  };

  /* ========== RENDER ========== */

  // Transition screen
  if(showTransition){const tp=transitionTarget;return(<div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4"><div className="bg-gray-900 border-2 border-yellow-500 rounded-2xl p-8 max-w-sm w-full text-center"><div className="text-6xl mb-4">🔒</div><h2 className="text-xl font-bold text-yellow-400 mb-3">请传递设备</h2>{tp&&<div className="mb-4"><div className="text-4xl mb-2">{AVATARS[tp.avatar]}</div><p className="text-lg font-bold">{tp.name}（{tp.id+1}号位）</p></div>}<button onClick={confirmTransition} className="bg-yellow-600 hover:bg-yellow-500 text-black font-bold px-8 py-3 rounded-xl text-lg w-full">✅ 继续</button></div></div>);}

  // Last words
  if(phase==='lastWords'&&lwQueue.length>0&&lwQIdx<lwQueue.length&&(!roomMode||lwQueue[lwQIdx]===mySeat)){
    const pid=lwQueue[lwQIdx];const p=R.current.players[pid];
    return(<div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4"><div className="bg-gray-900 border-2 border-amber-500 rounded-2xl p-6 max-w-lg w-full"><div className="text-center mb-4"><div className="text-5xl mb-2">📜</div><h2 className="text-xl font-bold text-amber-400">遗言 - {p.name}({p.id+1}号)</h2></div>
    {p.isHuman?(<div><textarea className="w-full bg-gray-950 text-gray-300 rounded p-3 text-sm h-28 mb-3 border border-gray-700" placeholder="遗言..." value={lwInput} onChange={e=>setLwInput(e.target.value)}/><button onClick={()=>confirmLastWords(lwInput||null)} className="bg-amber-600 hover:bg-amber-500 text-black font-bold px-4 py-2 rounded-xl w-full">{lwInput.trim()?'确认':'跳过'}</button></div>):(
    <div><div className="bg-gray-950 p-3 rounded mb-2 max-h-40 overflow-y-auto text-xs font-mono whitespace-pre-wrap text-gray-300">{lwPromptText}</div><button onClick={()=>copyText(lwPromptText,`lw_${pid}`)} className={`px-4 py-2 rounded w-full mb-2 text-sm ${copiedId===`lw_${pid}`?'bg-green-600':'bg-blue-600'}`}>{copiedId===`lw_${pid}`?'✓':'📋 复制'}</button><textarea className="w-full bg-gray-950 text-gray-300 rounded p-2 text-sm h-20 mb-2 border border-gray-700" placeholder="粘贴AI回复..." value={lwResponseText} onChange={e=>setLwResponseText(e.target.value)}/><div className="flex gap-2"><button onClick={()=>confirmLastWords(parseSpeech(lwResponseText)||null)} className="bg-amber-600 text-black font-bold px-4 py-2 rounded-xl flex-1" disabled={!lwResponseText.trim()}>处理</button><button onClick={()=>confirmLastWords(null)} className="bg-gray-700 px-4 py-2 rounded-xl">跳过</button></div></div>)}
    </div></div>);
  }

  // Night human screens (both API and manual mode)
  if(phase==='night'&&nightHumanState&&nightHumanQIdx>=0&&nightHumanQIdx<nightHumanQueue.length&&(!roomMode||nightHumanQueue[nightHumanQIdx]===mySeat)){
    const hid=nightHumanQueue[nightHumanQIdx];const hp=R.current.players[hid];const sub=step;
    const isFirstRound=R.current.round===1;
    const progressBar=<div className="mb-3"><div className="flex items-center justify-between mb-1"><span className="text-xs text-gray-300">{nightProgressLabel||'处理中...'}</span><span className="text-xs text-cyan-400 font-mono">{nightProgressPct}%</span></div><div className="w-full bg-gray-900 rounded-full h-2.5 overflow-hidden"><div className="h-full rounded-full transition-all duration-700 ease-out" style={{width:`${nightProgressPct}%`,background:'linear-gradient(90deg,#0e7490,#06b6d4,#22d3ee)'}}/></div></div>;
    // Role info block for first night (replaces separate roleReveal in API mode)
    const roleInfoBlock=isFirstRound&&R.current.apiAutoMode&&hp.role?(
      <div className="bg-gray-900/80 border border-yellow-600/50 rounded-lg p-3 mb-3 text-center">
        <p className="text-xs text-yellow-500 mb-1">🎴 你的身份</p>
        <p className="text-lg font-bold text-yellow-300">{RM[hp.role]}</p>
        {hp.role==='werewolf'&&<p className="text-xs text-red-400 mt-1">队友: {R.current.players.filter(q=>q.role==='werewolf'&&q.id!==hp.id).map(q=>`${q.name}(${q.id+1}号)`).join(', ')}</p>}
        {hp.role==='seer'&&<p className="text-xs text-purple-400 mt-1">每晚可查验一名玩家身份</p>}
        {hp.role==='witch'&&<p className="text-xs text-teal-400 mt-1">拥有一瓶解药和一瓶毒药</p>}
        {hp.role==='hunter'&&<p className="text-xs text-orange-400 mt-1">死亡时可开枪带走一人</p>}
        {hp.role==='idiot'&&<p className="text-xs text-pink-400 mt-1">被公投可翻牌免死</p>}
      </div>
    ):null;
    const isActive=(sub==='wolf'||sub==='werewolf'||sub==='wolfSeer')&&hp.role==='werewolf'||(sub==='seer'||sub==='wolfSeer')&&hp.role==='seer'||sub==='witch'&&hp.role==='witch';

    if(nightHumanState==='transition'){
      return(<div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4"><div className="bg-gray-900 border-2 border-yellow-500 rounded-2xl p-8 max-w-sm w-full text-center">{progressBar}<div className="text-6xl mb-4">🔒</div><h2 className="text-xl font-bold text-yellow-400 mb-3">请传递设备</h2><div className="text-4xl mb-2">{AVATARS[hp.avatar]}</div><p className="text-lg font-bold">{hp.name}（{hp.id+1}号）</p><p className="text-sm text-gray-500 mt-1">🌙 第{round}轮夜晚 · {sub==='wolfSeer'?'夜晚行动':sub==='wolf'||sub==='werewolf'?'狼人':sub==='seer'?'预言家':'女巫'}阶段</p>{apiAutoMode&&<p className="text-xs text-cyan-400 mt-2">🤖 AI玩家正在后台自动处理...</p>}<button onClick={confirmNightTransition} className="mt-6 bg-yellow-600 hover:bg-yellow-500 text-black font-bold px-8 py-3 rounded-xl text-lg w-full">✅ 继续</button></div></div>);
    }

    if(nightHumanState==='seerResult'&&seerCheckResult){
      const tp=R.current.players[seerCheckResult.target];
      return(<div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4"><div className="bg-gray-900 border-2 border-purple-500 rounded-2xl p-8 max-w-sm w-full text-center">{progressBar}<div className="text-5xl mb-4">🔮</div><h2 className="text-xl font-bold text-purple-400 mb-3">查验结果</h2><div className="text-3xl mb-2">{AVATARS[tp.avatar]}</div><p className="text-lg font-bold mb-2">{tp.name}（{tp.id+1}号）</p><div className={`text-2xl font-bold px-4 py-2 rounded-lg inline-block ${seerCheckResult.isWolf?'bg-red-900/60 text-red-300':'bg-green-900/60 text-green-300'}`}>{seerCheckResult.isWolf?'🐺 狼人':'✨ 好人'}</div><button onClick={advanceNightHuman} className="mt-6 bg-purple-600 hover:bg-purple-500 text-white font-bold px-8 py-3 rounded-xl w-full">确认</button></div></div>);
    }

    if(nightHumanState==='action'){
      if(!isActive){
        return(<div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4"><div className="bg-gray-900 border-2 border-gray-600 rounded-2xl p-8 max-w-sm w-full text-center">{progressBar}{roleInfoBlock}<div className="text-5xl mb-4">😴</div><p className="text-lg text-gray-400">暂时不需要行动</p><button onClick={advanceNightHuman} className="mt-6 bg-gray-600 hover:bg-gray-500 px-8 py-3 rounded-xl w-full font-bold">继续</button></div></div>);
      }

      if((sub==='wolf'||sub==='werewolf'||sub==='wolfSeer')&&hp.role==='werewolf'){
        const targets=R.current.players.filter(p=>p.alive&&p.role!=='werewolf');
        const mates=R.current.players.filter(q=>q.role==='werewolf'&&q.id!==hp.id&&q.alive);
        return(<div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4"><div className="bg-gray-900 border-2 border-red-600 rounded-2xl p-6 max-w-md w-full">{progressBar}{roleInfoBlock}<div className="text-center mb-4"><div className="text-4xl mb-2">🐺</div><h2 className="text-xl font-bold text-red-400">{hp.name} - 击杀</h2><p className="text-xs text-gray-500">队友: {mates.map(q=>`${q.name}(${q.id+1}号)`).join('、')}</p></div><div className="flex flex-wrap gap-2 mb-4">{targets.map(t=><button key={t.id} onClick={()=>setHumanAction(t.id)} className={`px-3 py-2 rounded text-sm ${humanAction===t.id?'bg-red-600':'bg-gray-700 hover:bg-gray-600'}`}>{AVATARS[t.avatar]} {t.name}({t.id+1}号)</button>)}</div><button onClick={processHumanNightAction} className="bg-red-600 hover:bg-red-500 px-4 py-3 rounded-xl w-full font-bold" disabled={typeof humanAction!=='number'}>确认</button></div></div>);
      }
      if((sub==='seer'||sub==='wolfSeer')&&hp.role==='seer'){
        const targets=R.current.players.filter(p=>p.alive&&p.id!==hp.id);
        return(<div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4"><div className="bg-gray-900 border-2 border-purple-600 rounded-2xl p-6 max-w-md w-full">{progressBar}{roleInfoBlock}<div className="text-center mb-4"><div className="text-4xl mb-2">🔮</div><h2 className="text-xl font-bold text-purple-400">{hp.name} - 查验</h2>{seerHistory.length>0&&<p className="text-xs text-gray-500">历史: {seerHistory.map(h=>`${R.current.players[h.target].name}→${h.isWolf?'狼':'好人'}`).join(', ')}</p>}</div><div className="flex flex-wrap gap-2 mb-4">{targets.map(t=><button key={t.id} onClick={()=>setHumanAction(t.id)} className={`px-3 py-2 rounded text-sm ${humanAction===t.id?'bg-purple-600':'bg-gray-700 hover:bg-gray-600'}`}>{AVATARS[t.avatar]} {t.name}({t.id+1}号)</button>)}</div><button onClick={processHumanNightAction} className="bg-purple-600 hover:bg-purple-500 px-4 py-3 rounded-xl w-full font-bold" disabled={typeof humanAction!=='number'}>确认</button></div></div>);
      }
      if(sub==='witch'&&hp.role==='witch'){
        const others=R.current.players.filter(p=>p.alive&&p.id!==hp.id);const nk=R.current.nightKill;
        const canSave=R.current.witchSave&&nk!==null&&(R.current.round===1||nk!==hp.id);
        return(<div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4"><div className="bg-gray-900 border-2 border-teal-600 rounded-2xl p-6 max-w-md w-full">{progressBar}{roleInfoBlock}<div className="text-center mb-4"><div className="text-4xl mb-2">🧪</div><h2 className="text-xl font-bold text-teal-400">{hp.name} - 女巫</h2></div><p className="text-sm mb-2">被杀: {nk!==null?`${R.current.players[nk].name}(${nk+1}号)`:'无'} | 解药:{R.current.witchSave?'✅':'❌'} | 毒药:{R.current.witchPoison?'✅':'❌'}</p><div className="flex flex-wrap gap-2 mb-4">{canSave&&<button onClick={()=>setHumanAction('save')} className={`px-3 py-2 rounded text-sm ${humanAction==='save'?'bg-green-600':'bg-gray-700'}`}>🧪 救人</button>}{R.current.witchPoison&&others.map(t=><button key={t.id} onClick={()=>setHumanAction(t.id)} className={`px-3 py-2 rounded text-sm ${humanAction===t.id?'bg-purple-600':'bg-gray-700'}`}>☠️{t.name}</button>)}<button onClick={()=>setHumanAction('skip')} className={`px-3 py-2 rounded text-sm ${humanAction==='skip'?'bg-gray-500':'bg-gray-700'}`}>🚫 不行动</button></div><button onClick={processHumanNightAction} className="bg-teal-600 hover:bg-teal-500 px-4 py-3 rounded-xl w-full font-bold" disabled={humanAction===null}>确认</button></div></div>);
      }
    }
    return null;
  }

  // Setup
  if(phase==='setup'){
    const mc=MODE_CONFIGS[gameMode];
    return(<div className="min-h-screen bg-gray-950 text-white p-4">
      <h1 className="text-2xl font-bold text-center mb-2">🐺 狼人杀 AI 辅助系统</h1>
      <p className="text-center text-gray-400 mb-4">{mc.roles.length}人局</p>
      {roomMode&&roomStateMeta&&<div className="max-w-3xl mx-auto mb-4 grid md:grid-cols-[1.15fr_0.85fr] gap-3"><div className="bg-gray-900 border border-cyan-700/40 rounded-2xl p-4"><div className="flex items-center justify-between mb-2"><div><h2 className="font-bold text-cyan-300">🌐 联机房间 {roomStateMeta.id}</h2><p className="text-xs text-gray-500 mt-1">{roomStateMeta.isPrivate?'🔒 私人房间':'公开房间'} {roomStateMeta.roomPassword?`· 密码 ${roomStateMeta.roomPassword}`:''}</p></div><button onClick={()=>network?.leaveRoom&&network.leaveRoom()} className="text-xs bg-gray-800 hover:bg-red-800 border border-gray-700 px-3 py-2 rounded-lg">关闭房间</button></div><div className="grid sm:grid-cols-2 gap-2">{roomMembers.map(member=><div key={member.sessionId} className="bg-gray-950/60 border border-gray-800 rounded-xl px-3 py-2 text-sm flex items-center justify-between gap-3"><span className="truncate">{member.displayName}{member.isHost?' 👑':''}</span><span className="text-xs text-gray-500">{member.seatId!==null&&member.seatId!==undefined?`${member.seatId+1}号位`:'旁观'}</span></div>)}</div></div><div className="bg-gray-900 border border-gray-800 rounded-2xl p-4"><h3 className="text-sm font-bold text-gray-200 mb-2">🪑 当前开放的人类席位</h3><div className="flex flex-wrap gap-2">{(roomStateMeta.availableSeats||[]).map(seat=><SeatBadge key={seat.id} seat={seat.id} occupiedName={seat.occupiedName} occupied={!!seat.occupiedBy} me={roomStateMeta.mySeat===seat.id}/>)}</div><p className="text-xs text-gray-500 mt-3">房主固定为1号玩家。把某个座位切换成“人类”后，远程玩家就可以在自己的设备加入该席位。</p></div></div>}
      <div className="max-w-2xl mx-auto mb-4"><div className="grid grid-cols-2 gap-3 mb-3">{Object.entries(MODE_CONFIGS).map(([k,cfg])=>(<button key={k} onClick={()=>changeMode(+k)} className={`p-3 rounded-xl border-2 text-left ${gameMode===+k?'border-red-500 bg-red-950/50':'border-gray-700 bg-gray-800 hover:border-gray-500'}`}><div className="font-bold text-sm mb-1">{cfg.icon} 模式{k}：{cfg.label}</div><div className="text-xs text-gray-400">{cfg.desc}</div>{cfg.descExtra&&<div className="text-xs text-yellow-400 mt-1">{cfg.descExtra}</div>}</button>))}</div></div>

      {/* API Auto Mode */}
      <div className="max-w-2xl mx-auto mb-4"><div className={`border-2 rounded-xl p-4 ${apiAutoMode?'border-cyan-500 bg-cyan-950/30':'border-gray-700 bg-gray-800'}`}><div className="flex items-center justify-between mb-2"><div className="flex items-center gap-2"><span className="text-lg">🤖</span><span className="font-bold text-cyan-300">API全自动模式</span></div><button onClick={()=>setApiAutoMode(!apiAutoMode)} className={`relative w-14 h-7 rounded-full transition-colors ${apiAutoMode?'bg-cyan-600':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full transition-transform ${apiAutoMode?'translate-x-7':''}`}/></button></div>{apiAutoMode&&<div><p className="text-xs text-cyan-400/80 mb-1">AI玩家通过API全自动游戏，人类玩家正常操作。</p><p className="text-xs text-yellow-400/80">明文提示词，每次包含完整游戏历史。AI无上下文。</p></div>}</div></div>

      {!apiAutoMode&&<div className="max-w-2xl mx-auto mb-4 flex items-center justify-center gap-4"><span className="text-sm">裁判模式:</span><button onClick={()=>setJudge('system')} className={`px-4 py-2 rounded ${judge==='system'?'bg-blue-600':'bg-gray-700'}`}>系统裁判</button><button onClick={()=>setJudge('human')} className={`px-4 py-2 rounded ${judge==='human'?'bg-blue-600':'bg-gray-700'}`}>人类裁判</button></div>}

      {/* Options */}
      <div className="max-w-2xl mx-auto mb-4"><div className="bg-gray-800 rounded-xl p-4 border border-gray-700"><h3 className="text-sm font-bold text-gray-300 mb-3">⚙️ 选项</h3><div className="grid grid-cols-2 gap-3">
        <div><div className="flex items-center gap-2"><span className="text-sm">📜 遗言</span><button onClick={()=>setEnableLastWords(!enableLastWords)} className={`relative w-10 h-5 rounded-full ${enableLastWords?'bg-amber-600':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${enableLastWords?'translate-x-5':''}`}/></button></div>{enableLastWords&&<div className="flex items-center gap-2 mt-1 ml-4"><span className="text-xs text-gray-400">🌙 夜间遗言</span><button onClick={()=>setAllowNightLastWords(!allowNightLastWords)} className={`relative w-8 h-4 rounded-full ${allowNightLastWords?'bg-amber-500':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${allowNightLastWords?'translate-x-4':''}`}/></button></div>}{enableLastWords&&allowNightLastWords&&<div className="flex items-center gap-2 mt-1 ml-4"><span className="text-xs text-gray-400">1️⃣ 仅第一夜</span><button onClick={()=>setOnlyFirstNightLW(!onlyFirstNightLW)} className={`relative w-8 h-4 rounded-full ${onlyFirstNightLW?'bg-amber-500':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${onlyFirstNightLW?'translate-x-4':''}`}/></button></div>}</div>
        <div className="flex items-center gap-2"><span className="text-sm">💀 公布身份</span><button onClick={()=>setRevealDeadIdentity(!revealDeadIdentity)} className={`relative w-10 h-5 rounded-full ${revealDeadIdentity?'bg-purple-600':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${revealDeadIdentity?'translate-x-5':''}`}/></button></div>
        <div className="flex items-center gap-2"><span className="text-sm">🧠 强化AI</span><button onClick={()=>setEnhanceAI(!enhanceAI)} className={`relative w-10 h-5 rounded-full ${enhanceAI?'bg-emerald-600':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${enhanceAI?'translate-x-5':''}`}/></button></div>
        <div className="flex items-center gap-2"><span className="text-sm">👑 管理员</span><button onClick={()=>setAdminMode(!adminMode)} className={`relative w-10 h-5 rounded-full ${adminMode?'bg-red-600':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${adminMode?'translate-x-5':''}`}/></button></div>
        <div className="flex items-center gap-2"><span className="text-sm">📜 日志</span><button onClick={()=>setShowLog(!showLog)} className={`relative w-10 h-5 rounded-full ${showLog?'bg-gray-400':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${showLog?'translate-x-5':''}`}/></button></div>
        <div className="flex items-center gap-2"><span className="text-sm">🎭 性格硬核</span><button onClick={()=>setPersonalityHardcore(!personalityHardcore)} className={`relative w-10 h-5 rounded-full ${personalityHardcore?'bg-yellow-600':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${personalityHardcore?'translate-x-5':''}`}/></button></div>
        <div><div className="flex items-center gap-2"><span className="text-sm">📝 字数</span><button onClick={()=>setWordLimitEnabled(!wordLimitEnabled)} className={`relative w-10 h-5 rounded-full ${wordLimitEnabled?'bg-blue-600':'bg-gray-600'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${wordLimitEnabled?'translate-x-5':''}`}/></button></div>{wordLimitEnabled&&<div className="flex items-center gap-1 mt-1"><input type="number" min="10" max="2000" value={wordLimitNum} onChange={e=>setWordLimitNum(Math.max(10,parseInt(e.target.value)||200))} className="w-16 bg-gray-900 text-white text-xs text-center rounded px-1 py-1 border border-gray-600"/><button onClick={()=>setWordLimitMode(wordLimitMode==='max'?'min':'max')} className={`px-2 py-0.5 rounded text-xs ${wordLimitMode==='max'?'bg-blue-700':'bg-orange-700'}`}>{wordLimitMode==='max'?'以内':'以上'}</button></div>}</div>
      </div></div></div>

      {/* Speech Order */}
      <div className="max-w-2xl mx-auto mb-4"><div className="bg-gray-800 rounded-xl p-4 border border-gray-700"><h3 className="text-sm font-bold text-gray-300 mb-3">🎙️ 发言顺序</h3><div className="flex flex-col gap-2">
        <button onClick={()=>setSpeechOrderMode(1)} className={`text-left px-3 py-2 rounded-lg border-2 ${speechOrderMode===1?'border-blue-500 bg-blue-950/40':'border-gray-700 bg-gray-900 hover:border-gray-500'}`}><div className="text-sm font-bold">🎲 随机顺序</div><div className="text-xs text-gray-400">随机选一个存活玩家开始，然后按座位号轮转</div></button>
        <button onClick={()=>setSpeechOrderMode(2)} className={`text-left px-3 py-2 rounded-lg border-2 ${speechOrderMode===2?'border-blue-500 bg-blue-950/40':'border-gray-700 bg-gray-900 hover:border-gray-500'}`}><div className="text-sm font-bold">1️⃣ 1号开始</div><div className="text-xs text-gray-400">每轮从1号开始按座位号顺序发言</div></button>
        <button onClick={()=>setSpeechOrderMode(3)} className={`text-left px-3 py-2 rounded-lg border-2 ${speechOrderMode===3?'border-blue-500 bg-blue-950/40':'border-gray-700 bg-gray-900 hover:border-gray-500'}`}><div className="text-sm font-bold">📋 标准</div><div className="text-xs text-gray-400">平安夜随机开始；有人死亡则从最小死者号的下一位开始</div></button>
      </div></div></div>

      {/* Players */}
      <div className="max-w-3xl mx-auto grid grid-cols-4 gap-3 mb-6">{players.map((p,i)=>(<div key={i} className="relative bg-gray-800 rounded-xl p-3 flex flex-col items-center border border-gray-700">
        {!p.isHuman&&<button onClick={()=>{setPersonalityPicker(i);setCustomPersonalityInput('');}} className={`absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full flex items-center justify-center text-xs z-10 ${p.personality?'bg-yellow-500 text-black':'bg-gray-600 text-gray-300 hover:bg-gray-500'}`}>⭐</button>}
        <div className="text-4xl mb-2 cursor-pointer hover:scale-110 transition-transform" onClick={()=>setPlayersSync(ps=>ps.map((pp,j)=>j===i?{...pp,avatar:(pp.avatar+1)%AVATARS.length}:pp))}>{AVATARS[p.avatar]}</div>
        <div className="text-xs text-gray-500 mb-1">{p.id+1}号 | {AVA_NAMES[p.avatar]}</div>
        {p.personality&&!p.isHuman&&<div className="text-xs text-yellow-400 truncate w-full text-center mb-1">🎭 {p.personality.length>6?p.personality.slice(0,6)+'…':p.personality}</div>}
        {editName===i?<input className="bg-gray-700 text-white text-sm text-center rounded px-2 py-1 w-full" defaultValue={p.name} onBlur={e=>{setPlayersSync(ps=>ps.map((pp,j)=>j===i?{...pp,name:e.target.value||pp.name}:pp));setEditName(null);}} onKeyDown={e=>{if(e.key==='Enter')e.target.blur();}} autoFocus/>:<div className="text-sm font-bold cursor-pointer hover:text-blue-400 truncate w-full text-center" onClick={()=>setEditName(i)}>{p.name}</div>}
        <div className="flex gap-2 mt-2"><button onClick={()=>setPlayersSync(ps=>ps.map((pp,j)=>j===i?{...pp,isHuman:true,personality:null}:pp))} className={`text-xs px-2 py-1 rounded ${p.isHuman?'bg-blue-600':'bg-gray-600'}`}>人类</button><button onClick={()=>setPlayersSync(ps=>ps.map((pp,j)=>j===i?{...pp,isHuman:false}:pp))} className={`text-xs px-2 py-1 rounded ${!p.isHuman?'bg-green-600':'bg-gray-600'}`}>AI</button></div>
        {apiAutoMode&&!p.isHuman&&<button onClick={()=>setApiConfigModal(i)} className={`mt-2 text-xs px-2 py-1 rounded-lg w-full ${apiConfigs[i]?.apiKey&&apiConfigs[i]?.apiUrl?'bg-cyan-900/50 border border-cyan-600 text-cyan-300':'bg-red-900/50 border border-red-600 text-red-300 animate-pulse'}`}>{apiConfigs[i]?.apiKey&&apiConfigs[i]?.apiUrl?`⚙️ ${(apiConfigs[i].model||'已配置').substring(0,12)}`:'⚠️ 配置API'}</button>}
      </div>))}</div>

      {/* Personality picker */}
      {personalityPicker!==null&&<div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={()=>setPersonalityPicker(null)}><div className="bg-gray-900 border-2 border-yellow-500 rounded-2xl p-5 max-w-sm w-full max-h-[80vh] overflow-y-auto" onClick={e=>e.stopPropagation()}><div className="flex items-center justify-between mb-3"><h2 className="font-bold text-yellow-400">⭐ AI性格 - {players[personalityPicker].name}</h2><button onClick={()=>setPersonalityPicker(null)} className="text-gray-400 hover:text-white">✕</button></div><div className="flex flex-col gap-1 mb-3"><button onClick={()=>{setPlayersSync(ps=>ps.map((pp,j)=>j===personalityPicker?{...pp,personality:null}:pp));setPersonalityPicker(null);}} className="text-left px-2.5 py-1.5 rounded-lg border border-gray-700 bg-gray-800 text-xs">🚫 无性格</button>{PERSONALITY_PRESETS.filter(pr=>pr.id!=='custom').map(pr=><button key={pr.id} onClick={()=>{setPlayersSync(ps=>ps.map((pp,j)=>j===personalityPicker?{...pp,personality:pr.label}:pp));setPersonalityPicker(null);}} className={`text-left px-2.5 py-1.5 rounded-lg border ${players[personalityPicker].personality===pr.label?'border-yellow-500 bg-yellow-950/50':'border-gray-700 bg-gray-800 hover:border-gray-500'}`}><div className="text-xs font-bold">{pr.label}</div><div className="text-xs text-gray-500">{pr.desc}</div></button>)}</div><div className="border border-gray-700 rounded-lg p-2.5 bg-gray-800"><div className="flex gap-1.5"><input className="flex-1 bg-gray-950 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-700" placeholder="自定义性格…" value={customPersonalityInput} onChange={e=>setCustomPersonalityInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&customPersonalityInput.trim()){setPlayersSync(ps=>ps.map((pp,j)=>j===personalityPicker?{...pp,personality:customPersonalityInput.trim()}:pp));setPersonalityPicker(null);}}}/><button onClick={()=>{if(customPersonalityInput.trim()){setPlayersSync(ps=>ps.map((pp,j)=>j===personalityPicker?{...pp,personality:customPersonalityInput.trim()}:pp));setPersonalityPicker(null);}}} className="bg-yellow-600 text-black text-xs font-bold px-3 py-1.5 rounded disabled:opacity-40" disabled={!customPersonalityInput.trim()}>确认</button></div></div></div></div>}

      <ApiConfigModal/>
      <div className="text-center mb-3"><span className="text-sm text-gray-400">人类:{players.filter(p=>p.isHuman).length} | AI:{players.filter(p=>!p.isHuman).length}</span>{apiAutoMode&&<span className="text-sm text-cyan-400 ml-2">🤖 API自动</span>}</div>

      {adminMode&&<div className="max-w-2xl mx-auto mb-4"><div className="bg-gray-800 rounded-xl p-4 border border-red-700/50"><div className="flex items-center justify-between mb-3"><h3 className="text-sm font-bold text-red-300">👑 管理员发牌</h3><div className="flex gap-2"><button onClick={()=>{setAdminCustomRoles(false);setCustomRoleAssign({});}} className={`text-xs px-3 py-1.5 rounded ${!adminCustomRoles?'bg-red-600':'bg-gray-700'}`}>🎲 随机</button><button onClick={()=>setAdminCustomRoles(true)} className={`text-xs px-3 py-1.5 rounded ${adminCustomRoles?'bg-red-600':'bg-gray-700'}`}>✋ 自定义</button></div></div>
      {adminCustomRoles&&<div className="flex flex-col gap-2">{(()=>{const mc=MODE_CONFIGS[gameMode];const rc={};mc.roles.forEach(r=>{rc[r]=(rc[r]||0)+1;});const ac={};Object.values(customRoleAssign).forEach(r=>{ac[r]=(ac[r]||0)+1;});return(<div><div className="flex flex-wrap gap-1.5 mb-3">{Object.entries(rc).map(([r,n])=><span key={r} className={`text-xs px-2 py-1 rounded ${(ac[r]||0)===n?'bg-green-800 text-green-200':(ac[r]||0)>n?'bg-yellow-800 text-yellow-200':'bg-gray-700 text-gray-300'}`}>{RM[r]}:{ac[r]||0}/{n}</span>)}</div><div className="grid grid-cols-2 gap-2">{players.slice(0,mc.roles.length).map((p,i)=><div key={i} className="flex items-center gap-2 bg-gray-900 rounded-lg p-2"><span className="text-lg">{AVATARS[p.avatar]}</span><span className="text-xs flex-1 truncate">{i+1}号{p.name}</span><select value={customRoleAssign[i]||''} onChange={e=>{const v=e.target.value;setCustomRoleAssign(prev=>{const n={...prev};if(v)n[i]=v;else delete n[i];return n;});}} className="bg-gray-800 text-xs rounded px-1.5 py-1 border border-gray-600 text-white"><option value="">选择</option>{[...new Set(mc.roles)].map(r=><option key={r} value={r}>{RM[r]}</option>)}</select></div>)}</div></div>);})()}</div>}
      </div></div>}

      <div className="text-center"><button onClick={startGame} className="bg-red-600 hover:bg-red-500 text-white font-bold text-lg px-8 py-3 rounded-xl">{apiAutoMode?'🤖 开始':'开始游戏'}</button></div>
    </div>);
  }

  // Game over
  if(phase==='gameOver'){
    return(<div className="min-h-screen bg-gray-950 text-white p-4 flex flex-col items-center justify-center">
      <div className="text-6xl mb-4">{gameResult==='good'?'🎉':'🐺'}</div><h1 className="text-3xl font-bold mb-2">{gameResult==='good'?'好人阵营胜利！':'狼人阵营胜利！'}</h1>
      <div className="bg-gray-800 rounded-xl p-4 mt-4 max-w-md w-full"><h3 className="font-bold mb-2 text-center">身份揭示</h3><div className="grid grid-cols-2 gap-2">{players.map(p=><div key={p.id} className={`flex items-center gap-2 p-2 rounded ${p.alive?'bg-gray-700':'bg-gray-900 opacity-60'}`}><span>{AVATARS[p.avatar]}</span><span className="text-sm">{p.name}</span><span className={`text-xs ml-auto px-1 rounded ${p.role==='werewolf'?'bg-red-800':'bg-green-800'}`}>{RM[p.role]}</span></div>)}</div></div>
      {gameHistory.length>0&&<div className="bg-gray-800 rounded-xl p-4 mt-4 max-w-md w-full max-h-64 overflow-y-auto"><h3 className="font-bold mb-2">📋 游戏历史</h3>{gameHistory.map((l,i)=><div key={i} className="text-xs text-gray-400 mb-1 whitespace-pre-wrap">{l}</div>)}</div>}
      {showLog&&<div className="bg-gray-800 rounded-xl p-4 mt-4 max-w-md w-full max-h-48 overflow-y-auto"><h3 className="font-bold mb-2">📜 日志</h3>{log.map((l,i)=><div key={i} className="text-xs text-gray-500 mb-1">{l}</div>)}</div>}
      <button onClick={resetGame} className="mt-4 bg-blue-600 hover:bg-blue-500 px-6 py-2 rounded-lg font-bold">重新开始</button>
    </div>);
  }

  // Hunter shot
  if(phase==='hunterShot'&&(!roomMode||hunterShotPending===mySeat)){
    const hunter=R.current.players[hunterShotPending];const others=R.current.players.filter(p=>p.alive&&p.id!==hunter.id);
    return(<div className="min-h-screen bg-gray-950 text-white p-4 flex flex-col items-center justify-center"><div className="bg-gray-900 border-2 border-orange-500 rounded-2xl p-6 max-w-lg w-full"><div className="text-center mb-4"><div className="text-5xl mb-2">🏹</div><h2 className="text-xl font-bold text-orange-400">{hunter.name} 猎人开枪</h2></div>
    {hunter.isHuman?(<div><div className="flex flex-wrap gap-2 mb-4">{others.map(t=><button key={t.id} onClick={()=>setHumanAction(t.id)} className={`px-3 py-2 rounded text-sm ${humanAction===t.id?'bg-orange-600':'bg-gray-700'}`}>{AVATARS[t.avatar]} {t.name}</button>)}<button onClick={()=>setHumanAction('skip')} className={`px-3 py-2 rounded text-sm ${humanAction==='skip'?'bg-gray-500':'bg-gray-700'}`}>🚫 不开枪</button></div><button onClick={()=>processHunterShot(humanAction==='skip'?null:typeof humanAction==='number'?humanAction:null)} className="bg-orange-600 px-4 py-2 rounded w-full font-bold" disabled={humanAction===null}>确认</button></div>):(
    <div><div className="bg-gray-950 p-3 rounded mb-2 max-h-40 overflow-y-auto text-xs font-mono whitespace-pre-wrap text-gray-300">{enhancePrompt(makeHunterShootPrompt(enc,hunter,R.current.players,{round}))}</div><button onClick={()=>copyText(enhancePrompt(makeHunterShootPrompt(enc,hunter,R.current.players,{round})))} className={`px-4 py-2 rounded w-full mb-2 ${copied?'bg-green-600':'bg-blue-600'}`}>{copied?'✓':'📋 复制'}</button><textarea className="w-full bg-gray-950 text-gray-300 rounded p-2 text-sm h-20 mb-2" placeholder="粘贴AI回复..." value={responseText} onChange={e=>setResponseText(e.target.value)}/><button onClick={()=>{const pa=parseAction(responseText,enc);if(pa?.action==='shoot'&&pa.target!==null)processHunterShot(pa.target);else if(pa?.action==='skip')processHunterShot(null);else alert('无法解析');}} className="bg-orange-600 px-4 py-2 rounded w-full font-bold" disabled={!responseText.trim()}>处理</button></div>)}
    </div></div>);
  }

  /* ===== MAIN GAME VIEW ===== */
  const cur=stepQueue.length>0&&qIdx<stepQueue.length?players[stepQueue[qIdx]]:null;
  const vc={};Object.entries(votes).forEach(([,t])=>{if(t!=='abstain')vc[t]=(vc[t]||0)+1;});

  const adminToggleAlive=(pid)=>{
    if(!R.current.adminModeAvail)return;
    const ps=[...R.current.players];
    const p=ps[pid];
    ps[pid]={...p,alive:!p.alive};
    if(!p.alive)ps[pid].canVote=true; // revive restores vote
    setPlayersSync(ps);
    addLog(`👻 管理员${p.alive?'击杀':'复活'}了 ${p.name}(${pid+1}号)`);
  };

  const PCV=({p})=>{
    const isVoting=phase==='day'&&step==='vote'&&votingActive;
    const hv=votes[p.id]!==undefined;const isAbstain=votes[p.id]==='abstain';
    const rv=vc[p.id]||0;const isSV=selectedVoter===p.id;
    const canClick=isVoting&&p.alive&&p.canVote!==false&&(!hv||isAbstain)&&selectedVoter===null&&(R.current.apiAutoMode?(roomMode?p.id===mySeat:p.isHuman):true);
    const as=apiStatus[p.id];
    const showSpeaking=phase==='day'&&step==='speech'&&as==='speaking';
    return(<div onClick={()=>{if(canClick)selectVoter(p.id);}} className={`relative flex items-center gap-2 p-2 rounded-lg border transition-all ${!p.alive?'opacity-40 border-gray-800 bg-gray-900':'border-gray-700 bg-gray-800'} ${isSV?'!border-cyan-400 ring-2 ring-cyan-400':''} ${canClick?'cursor-pointer hover:border-blue-400':''} ${hv&&!isAbstain?'!border-green-700':''}`}>
      <span className="text-2xl">{AVATARS[p.avatar]}</span>
      <div className="min-w-0 flex-1"><div className="text-xs text-gray-500">{p.id+1}号{p.isHuman?' 👤':' 🤖'}</div><div className="text-sm font-bold truncate">{p.name}</div>{!p.alive&&<div className="text-xs text-red-500">出局{revealDeadIdentity&&p.role&&<span className={`ml-1 px-1 rounded ${p.role==='werewolf'?'bg-red-800 text-red-200':p.role==='seer'?'bg-purple-800 text-purple-200':p.role==='witch'?'bg-teal-800 text-teal-200':p.role==='hunter'?'bg-orange-800 text-orange-200':p.role==='idiot'?'bg-pink-800 text-pink-200':'bg-green-800 text-green-200'}`}>{RM[p.role]}</span>}</div>}{showSpeaking&&<div className="text-xs text-cyan-400 animate-pulse">💬 发言中...</div>}</div>
      {hv&&!isAbstain&&<div className="absolute -top-2 -right-2 bg-blue-600 text-white text-xs rounded-full w-6 h-6 flex items-center justify-center font-bold shadow-lg">→{votes[p.id]+1}</div>}
      {isAbstain&&<div className="absolute -top-2 -right-2 bg-orange-600 text-white text-xs rounded-full px-1.5 py-0.5 font-bold shadow-lg">弃</div>}
      {isVoting&&rv>0&&p.alive&&<div className="absolute -bottom-2 -right-2 bg-red-600 text-white text-xs rounded-full px-1.5 py-0.5 font-bold shadow-lg">{rv}票</div>}
      {isVoting&&p.alive&&p.canVote!==false&&!hv&&!isSV&&(R.current.apiAutoMode?p.isHuman:true)&&<div className="absolute -top-1 -left-1 w-3 h-3 bg-yellow-500 rounded-full animate-pulse"/>}
      {R.current.adminModeAvail&&!isVoting&&<button onClick={e=>{e.stopPropagation();adminToggleAlive(p.id);}} className={`absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full flex items-center justify-center text-xs z-10 ${p.alive?'bg-gray-700 hover:bg-red-700 border border-gray-600':'bg-green-700 hover:bg-green-600 border border-green-500'}`} title={p.alive?'击杀':'复活'}>👻</button>}
    </div>);
  };

  const renderAP=()=>{
    if(phase==='roleReveal'){
      const p=players[stepQueue[qIdx]];
      const remoteHumanReveal=roomMode&&p.isHuman&&p.id!==mySeat;
      return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-yellow-400 mb-2">📋 身份 - {p.name}({p.id+1}号) {p.isHuman?'[人类]':'[AI]'}</h3>
      {remoteHumanReveal?(<div className="bg-gray-900 rounded-lg p-4 text-sm text-gray-400">已将身份发放到该玩家自己的设备，等待对方确认…</div>):p.isHuman?(<div><div className="bg-gray-900 p-3 rounded mb-3 text-center">{showRole&&<p className="text-xl font-bold text-yellow-300">身份: {RM[showRole.role]}</p>}{showRole?.role==='werewolf'&&<p className="text-sm text-red-400 mt-1">队友: {players.filter(q=>q.role==='werewolf'&&q.id!==p.id).map(q=>`${q.name}(${q.id+1}号)`).join(', ')}</p>}{showRole?.role==='seer'&&<p className="text-sm text-purple-400 mt-1">每晚查验一名玩家</p>}{showRole?.role==='witch'&&<p className="text-sm text-teal-400 mt-1">拥有解药和毒药</p>}{showRole?.role==='hunter'&&<p className="text-sm text-orange-400 mt-1">死亡时可开枪</p>}</div><button onClick={nextRoleReveal} className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded w-full">确认，下一位</button></div>):(
      <div><div className="bg-gray-900 p-3 rounded mb-2 max-h-48 overflow-y-auto text-xs font-mono whitespace-pre-wrap text-gray-300">{promptText}</div><div className="flex gap-2"><button onClick={()=>copyText(promptText)} className={`px-4 py-2 rounded flex-1 ${copied?'bg-green-600':'bg-blue-600'}`}>{copied?'✓':'📋 复制'}</button><button onClick={nextRoleReveal} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded flex-1">下一位</button></div></div>)}
      <p className="text-xs text-gray-500 mt-2">{qIdx+1}/{stepQueue.length}</p></div>);
    }

    if(phase==='night'&&!R.current.apiAutoMode){
      // Manual night panel
      const sub=step;const aiIds=Object.keys(nightPrompts).map(Number);const allDone=aiIds.every(id=>nightResponseMap[id]?.trim());const humansDone=!nightHumanState;
      return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-red-400 mb-2">🌙 第{round}轮夜晚 - {sub==='werewolf'?'狼人':sub==='seer'?'预言家':'女巫'}</h3>
      <div className="flex flex-wrap gap-2 mb-3">{aiIds.map(id=>{const p=players[id];const hr=nightResponseMap[id]?.trim();return(<button key={id} onClick={()=>setExpandedPlayerId(expandedPlayerId===id?null:id)} className={`flex items-center gap-1 px-3 py-2 rounded-lg border-2 text-sm ${expandedPlayerId===id?'border-cyan-400 bg-cyan-950/50':hr?'border-green-600 bg-green-950/30':'border-gray-600 bg-gray-900'}`}><span>{AVATARS[p.avatar]}</span><span className="font-bold">{p.name}</span>{hr?<span className="text-green-400">✅</span>:<span className="text-gray-500 animate-pulse">⏳</span>}</button>);})}</div>
      {expandedPlayerId!==null&&nightPrompts[expandedPlayerId]&&(()=>{const p=players[expandedPlayerId];return(<div className="bg-gray-900 border border-gray-600 rounded-xl p-4 mb-3"><div className="flex items-center justify-between mb-2"><span className="font-bold">{AVATARS[p.avatar]} {p.name}</span><button onClick={()=>setExpandedPlayerId(null)} className="text-gray-400 hover:text-white">✕</button></div><div className="bg-gray-950 p-3 rounded mb-2 max-h-48 overflow-y-auto text-xs font-mono whitespace-pre-wrap text-gray-300">{nightPrompts[expandedPlayerId]}</div><button onClick={()=>copyText(nightPrompts[expandedPlayerId],expandedPlayerId)} className={`px-4 py-2 rounded w-full mb-2 text-sm ${copiedId===expandedPlayerId?'bg-green-600':'bg-blue-600'}`}>{copiedId===expandedPlayerId?'✓':'📋 复制'}</button><textarea className="w-full bg-gray-950 text-gray-300 rounded p-2 text-sm h-24 border border-gray-700" placeholder="粘贴回复..." value={nightResponseMap[expandedPlayerId]||''} onChange={e=>setNightResponseMap(prev=>({...prev,[expandedPlayerId]:e.target.value}))}/></div>);})()}
      {!humansDone&&<div className="text-xs text-cyan-400 mb-3">⏳ 仍有远程人类玩家尚未完成夜间操作</div>}<button onClick={processManualNightResponses} className={`px-4 py-3 rounded-xl w-full font-bold text-lg ${((allDone||!aiIds.length)&&humansDone)?'bg-green-600 hover:bg-green-500':'bg-gray-700 text-gray-500'}`} disabled={!((allDone||!aiIds.length)&&humansDone)}>{((allDone||!aiIds.length)&&humansDone)?'✅ 处理':'⏳ 等待'}</button></div>);
    }

    if(phase==='night'&&R.current.apiAutoMode){
      // API mode night - show generic progress bar (no per-player info to avoid leaking roles)
      return(<div className="bg-gray-800 rounded-xl p-4">
        <h3 className="font-bold text-cyan-400 mb-3">🌙 第{round}轮夜晚</h3>
        <div className="mb-2"><div className="flex items-center justify-between mb-1"><span className="text-sm text-gray-300">{nightProgressLabel||'处理中...'}</span><span className="text-sm text-cyan-400 font-mono">{nightProgressPct}%</span></div><div className="w-full bg-gray-900 rounded-full h-3 overflow-hidden"><div className="h-full rounded-full transition-all duration-700 ease-out" style={{width:`${nightProgressPct}%`,background:'linear-gradient(90deg,#0e7490,#06b6d4,#22d3ee)'}}/></div></div>
        <div className="flex items-center gap-2 mt-3"><div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse"/><p className="text-xs text-gray-500">各角色正在夜晚行动，请等待...</p></div>
      </div>);
    }

    if(phase==='day'&&step==='announce'){
      const roundLW=lastWordsList.filter(lw=>lw.round===round&&lw.context==='night');
      const previewOrder=R.current.precomputedSpeechOrder||[];
      return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-yellow-400 mb-2">☀️ 第{round}轮白天</h3><div className="bg-gray-900 p-3 rounded mb-3 text-center"><p className="text-lg">{nightResultMsg}</p></div>
      {roundLW.length>0&&<div className="bg-amber-950/30 border border-amber-700/50 rounded-lg p-2 mb-3">{roundLW.map((lw,i)=><div key={i} className="text-sm text-gray-300 mb-1"><span className="text-amber-400 font-bold">📜 {lw.name}遗言：</span>{lw.text}</div>)}</div>}
      {previewOrder.length>0&&<div className="text-xs text-gray-500 mb-3 text-center">🎙️ 发言顺序：{previewOrder.map(id=>`${id+1}号${players[id].name}`).join(' → ')}</div>}
      <button onClick={startSpeeches} className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded w-full">开始发言</button></div>);
    }

    if(phase==='day'&&step==='speech'){
      const p=cur;if(!p)return null;
      // Check if this is API auto-speech in progress (AI player, no callback)
      if(R.current.apiAutoMode&&!p.isHuman){
        return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-yellow-400 mb-2">💬 发言中...</h3>{speeches.length>0&&<div className="bg-gray-900 rounded p-2 mb-2 max-h-48 overflow-y-auto">{speeches.map((s,i)=><div key={i} className="text-xs text-gray-400 mb-1"><span className="text-blue-400 font-bold">{s.name}:</span> {s.text}</div>)}</div>}<p className="text-sm text-cyan-400 animate-pulse">🤖 {p.name} 正在通过API发言...</p></div>);
      }
      const remoteHumanSpeech=roomMode&&p.isHuman&&p.id!==mySeat;
      return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-yellow-400 mb-2">💬 {p.name}({p.id+1}号) {p.isHuman?'[人类]':'[AI]'}</h3>
      {speeches.length>0&&<div className="bg-gray-900 rounded p-2 mb-2 max-h-40 overflow-y-auto">{speeches.map((s,i)=><div key={i} className="text-xs text-gray-400 mb-1"><span className="text-blue-400">{s.name}:</span> {s.text}</div>)}</div>}
      {remoteHumanSpeech?(<div className="bg-gray-900 rounded p-4 text-sm text-gray-400">等待该玩家在自己的设备上发言…</div>):p.isHuman?(<div><textarea className="w-full bg-gray-900 text-gray-300 rounded p-2 text-sm h-20 mb-2" placeholder="发言..." value={responseText} onChange={e=>setResponseText(e.target.value)}/><button onClick={()=>{if(R.current.apiAutoMode&&R.current.speechCallback){submitSpeech(responseText||'(未发言)');}else procSpeech();}} className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded w-full">确认发言</button></div>):(
      <div><div className="bg-gray-900 p-3 rounded mb-2 max-h-36 overflow-y-auto text-xs font-mono whitespace-pre-wrap text-gray-300">{promptText}</div><button onClick={()=>copyText(promptText)} className={`px-4 py-2 rounded w-full mb-2 ${copied?'bg-green-600':'bg-blue-600'}`}>{copied?'✓':'📋 复制'}</button><textarea className="w-full bg-gray-900 text-gray-300 rounded p-2 text-sm h-20 mb-2" placeholder="粘贴AI回复..." value={responseText} onChange={e=>setResponseText(e.target.value)}/><button onClick={procSpeech} className="bg-green-600 hover:bg-green-500 px-4 py-2 rounded w-full" disabled={!responseText.trim()}>处理</button></div>)}
      <p className="text-xs text-gray-500 mt-2">{qIdx+1}/{stepQueue.length}</p></div>);
    }

    if(phase==='day'&&step==='vote'&&votingActive){
      const alive=players.filter(p=>p.alive&&p.canVote!==false);const voted=voteOrder.length;const total=alive.length;
      const humanPending=R.current.pendingVoteHumans||[];
      const sv=selectedVoter!==null?players[selectedVoter]:null;

      // API mode: humans and AI vote simultaneously
      if(R.current.apiAutoMode){
        const speechPanel=speeches.length>0&&<div className="bg-gray-900/50 border border-gray-700 rounded-lg p-2 mb-3 max-h-48 overflow-y-auto"><p className="text-xs font-bold text-gray-500 mb-1">💬 本轮发言回顾</p>{speeches.map((s,i)=><div key={i} className="text-xs text-gray-400 mb-1"><span className="text-blue-400 font-bold">{s.name}:</span> {s.text}</div>)}</div>;
        const aiStillVoting=!R.current.aiVoteDone;
        const nextHuman=humanPending[0];
        return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-yellow-400 mb-2">🗳️ 投票 ({voted}/{total}){aiStillVoting&&<span className="text-xs text-cyan-400 ml-2 animate-pulse">AI投票中...</span>}</h3>
        {speechPanel}
        {voteOrder.length>0&&<div className="bg-gray-950 rounded p-2 mb-3 max-h-24 overflow-y-auto">{voteOrder.map(fid=><p key={fid} className="text-xs text-gray-400">{players[fid].name}→{votes[fid]==='abstain'?'弃票':players[votes[fid]]?.name}</p>)}</div>}
        {sv?(<div className="bg-gray-900 rounded p-3"><p className="text-sm mb-2"><span className="text-cyan-400 font-bold">{sv.name}</span> 投票</p><div className="flex flex-wrap gap-2 mb-3">{players.filter(t=>t.alive&&t.id!==sv.id).map(t=><button key={t.id} onClick={()=>setSelectedVoteTarget(t.id)} className={`px-3 py-1 rounded text-sm ${selectedVoteTarget===t.id?'bg-yellow-600':'bg-gray-700'}`}>{t.name}({t.id+1}号)</button>)}<button onClick={()=>setSelectedVoteTarget('abstain')} className={`px-3 py-1 rounded text-sm ${selectedVoteTarget==='abstain'?'bg-orange-600':'bg-gray-700'}`}>弃票</button></div><button onClick={confirmHumanVoteAPI} className="bg-yellow-600 hover:bg-yellow-500 px-4 py-2 rounded w-full" disabled={selectedVoteTarget===null}>确认</button></div>):nextHuman!==undefined?(roomMode&&nextHuman!==mySeat?<div className="text-sm text-gray-400">等待 <span className="text-yellow-400 font-bold">{players[nextHuman].name}</span> 在自己的设备上投票…</div>:<div><p className="text-sm text-gray-300 mb-2">轮到 <span className="text-yellow-400 font-bold">{players[nextHuman].name}</span> 投票</p><button onClick={()=>{setSelectedVoter(nextHuman);setSelectedVoteTarget(null);}} className="bg-yellow-600 hover:bg-yellow-500 px-4 py-2 rounded w-full">开始投票</button></div>):aiStillVoting?(<div className="flex items-center gap-2 py-2"><div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse"/><p className="text-sm text-gray-400">你已投票完毕，等待AI投票...</p></div>):null}
        </div>);
      }

      // Manual mode voting
      return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-yellow-400 mb-2">🗳️ 投票 ({voted}/{total})</h3>
      {speeches.length>0&&<div className="bg-gray-900/50 border border-gray-700 rounded-lg p-2 mb-3 max-h-48 overflow-y-auto"><p className="text-xs font-bold text-gray-500 mb-1">💬 本轮发言回顾</p>{speeches.map((s,i)=><div key={i} className="text-xs text-gray-400 mb-1"><span className="text-blue-400 font-bold">{s.name}:</span> {s.text}</div>)}</div>}
      <p className="text-sm text-gray-400 mb-3">点击上方闪烁玩家投票</p>
      {voteOrder.length>0&&<div className="bg-gray-950 rounded p-2 mb-3">{voteOrder.map(fid=><p key={fid} className="text-xs text-gray-400">{players[fid].name}→{votes[fid]==='abstain'?'弃票':players[votes[fid]]?.name}</p>)}</div>}
      {sv===null?<p className="text-gray-500 text-sm text-center">选择一位未投票玩家</p>:(
      <div className="bg-gray-900 rounded p-3"><p className="text-sm mb-2"><span className="text-cyan-400 font-bold">{sv.name}</span>{sv.isHuman?' [人类]':' [AI]'} <button onClick={()=>{setSelectedVoter(null);setSelectedVoteTarget(null);setResponseText('');}} className="text-xs text-gray-500 ml-2 underline">取消</button></p>
      {roomMode&&sv.isHuman&&sv.id!==mySeat?(<div className="text-sm text-gray-400">等待该玩家在自己的设备上投票…</div>):sv.isHuman?(<div><div className="flex flex-wrap gap-2 mb-3">{players.filter(t=>t.alive&&t.id!==sv.id).map(t=><button key={t.id} onClick={()=>setSelectedVoteTarget(t.id)} className={`px-3 py-1 rounded text-sm ${selectedVoteTarget===t.id?'bg-yellow-600':'bg-gray-700'}`}>{t.name}({t.id+1}号)</button>)}<button onClick={()=>setSelectedVoteTarget('abstain')} className={`px-3 py-1 rounded text-sm ${selectedVoteTarget==='abstain'?'bg-orange-600':'bg-gray-700'}`}>弃票</button></div><button onClick={confirmVote} className="bg-yellow-600 px-4 py-2 rounded w-full" disabled={selectedVoteTarget===null}>确认</button></div>):(
      <div><div className="flex flex-wrap gap-1.5 mb-2">{players.filter(t=>t.alive&&t.id!==sv.id).map(t=><button key={t.id} onClick={()=>setSelectedVoteTarget(t.id)} className={`px-2 py-1 rounded text-xs ${selectedVoteTarget===t.id?'bg-yellow-600 font-bold':'bg-gray-700'}`}>{t.name}({t.id+1}号)</button>)}<button onClick={()=>setSelectedVoteTarget('abstain')} className={`px-2 py-1 rounded text-xs ${selectedVoteTarget==='abstain'?'bg-orange-600':'bg-gray-700'}`}>弃票</button></div>{selectedVoteTarget!==null&&<button onClick={confirmVote} className="bg-yellow-600 px-4 py-2 rounded w-full mb-2 text-sm font-bold">手动确认</button>}<div className="border-t border-gray-700 pt-2"><div className="bg-gray-950 p-2 rounded mb-2 max-h-36 overflow-y-auto text-xs font-mono whitespace-pre-wrap text-gray-300">{promptText}</div><button onClick={()=>copyText(promptText)} className={`px-4 py-2 rounded w-full mb-2 ${copied?'bg-green-600':'bg-blue-600'}`}>{copied?'✓':'📋 复制'}</button><textarea className="w-full bg-gray-950 text-gray-300 rounded p-2 text-sm h-16 mb-2" placeholder="粘贴AI回复..." value={responseText} onChange={e=>{setResponseText(e.target.value);setSelectedVoteTarget(null);}}/><button onClick={confirmVote} className="bg-green-600 px-4 py-2 rounded w-full" disabled={!responseText.trim()}>处理</button></div></div>)}
      </div>)}
      <div className="mt-3 border-t border-gray-700 pt-2"><button onClick={endVotingEarly} className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded w-full text-sm">⏹️ 结束投票</button></div></div>);
    }

    if(phase==='lastWords'){const pid=lwQueue[lwQIdx];const p=players[pid];return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-amber-400 mb-2">📜 遗言中</h3><p className="text-sm text-gray-400">等待 <span className="text-amber-300 font-bold">{p?.name||'玩家'}</span> 在自己的设备上发表遗言…</p></div>);}

    if(phase==='hunterShot'){const p=players[hunterShotPending];return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-orange-400 mb-2">🏹 猎人处理中</h3><p className="text-sm text-gray-400">等待 <span className="text-orange-300 font-bold">{p?.name||'猎人'}</span> 在自己的设备上选择是否开枪…</p></div>);}

    if(phase==='dayResult'){
      const roundLW=lastWordsList.filter(lw=>lw.round===round&&lw.context==='vote');
      return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-yellow-400 mb-2">📊 结果</h3>
      {speeches.length>0&&<div className="bg-gray-900/50 border border-gray-700 rounded-lg p-2 mb-3 max-h-40 overflow-y-auto"><p className="text-xs font-bold text-gray-500 mb-1">💬 本轮发言</p>{speeches.map((s,i)=><div key={i} className="text-xs text-gray-400 mb-1"><span className="text-blue-400 font-bold">{s.name}:</span> {s.text}</div>)}</div>}
      <div className="bg-gray-900 p-3 rounded mb-3 text-center whitespace-pre-line">{promptText}</div>
      {roundLW.length>0&&<div className="bg-amber-950/30 border border-amber-700/50 rounded-lg p-2 mb-3">{roundLW.map((lw,i)=><div key={i} className="text-sm text-gray-300 mb-1"><span className="text-amber-400 font-bold">📜 {lw.name}遗言：</span>{lw.text}</div>)}</div>}
      <button onClick={nextRound} className="bg-red-600 hover:bg-red-500 px-4 py-2 rounded w-full">下一轮</button></div>);
    }
    // Fallback: show speeches during any day phase transition gap
    if(phase==='day'&&speeches.length>0){
      return(<div className="bg-gray-800 rounded-xl p-4"><h3 className="font-bold text-yellow-400 mb-2">📊 处理中...</h3>
      <div className="bg-gray-900/50 border border-gray-700 rounded-lg p-2 mb-3 max-h-48 overflow-y-auto"><p className="text-xs font-bold text-gray-500 mb-1">💬 本轮发言</p>{speeches.map((s,i)=><div key={i} className="text-xs text-gray-400 mb-1"><span className="text-blue-400 font-bold">{s.name}:</span> {s.text}</div>)}</div>
      <div className="flex items-center gap-2"><div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse"/><p className="text-sm text-gray-400">正在处理投票结果...</p></div></div>);
    }
    return null;
  };

  return(<div className="min-h-screen bg-gray-950 text-white p-3"><div className="max-w-4xl mx-auto">
    <div className="flex items-center justify-between mb-3"><div><h1 className="text-lg font-bold">🐺 第{round}轮</h1>{roomMode&&roomStateMeta&&<div className="text-xs text-gray-500 mt-1">房间 {roomStateMeta.id} · {roomStateMeta.isPrivate?'🔒私人':'🌐公开'} · 你是{mySeat+1}号位</div>}</div><div className="flex items-center gap-2 flex-wrap justify-end">{roomMode&&<HornButton count={roomPendingAiCount} onClick={()=>network?.accelerateAI&&network.accelerateAI()} disabled={roomPendingAiCount<=0||!players[mySeat]?.isHuman}/>} {R.current.adminModeAvail&&<button onClick={()=>{const nv=!R.current.adminMode;R.current.adminMode=nv;setAdminMode(nv);}} className={`text-xs px-2 py-1 rounded border ${R.current.adminMode?'bg-red-900/60 border-red-500 text-red-300':'bg-gray-800 border-gray-600 text-gray-500'}`}>{R.current.adminMode?'👑 管理员ON':'👑 OFF'}</button>}{R.current.adminModeAvail&&<button onClick={()=>setShowAllRolesModal(!showAllRolesModal)} className="text-xs px-2 py-1 rounded border border-yellow-600 bg-yellow-900/40 text-yellow-300">🃏 看牌</button>}{apiAutoMode&&<span className="text-xs px-2 py-1 bg-cyan-900 border border-cyan-600 rounded text-cyan-300">🤖API</span>}<span className="text-xs px-2 py-1 bg-gray-800 rounded">{phase==='night'?'🌙':phase.startsWith('day')?'☀️':'📋'}</span>{roomMode&&<button onClick={()=>network?.leaveRoom&&network.leaveRoom()} className="text-xs bg-gray-700 hover:bg-red-800 px-2 py-1 rounded">离房</button>}<button onClick={resetGame} className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded">重置</button></div></div>
    {showAllRolesModal&&<div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={()=>setShowAllRolesModal(false)}><div className="bg-gray-900 border-2 border-yellow-500 rounded-2xl p-5 max-w-sm w-full" onClick={e=>e.stopPropagation()}><div className="flex items-center justify-between mb-3"><h2 className="font-bold text-yellow-400">🃏 所有玩家身份</h2><button onClick={()=>setShowAllRolesModal(false)} className="text-gray-400 hover:text-white text-lg">✕</button></div><div className="flex flex-col gap-2">{players.map(p=><div key={p.id} className={`flex items-center gap-3 p-2 rounded-lg ${p.alive?'bg-gray-800':'bg-gray-800/50 opacity-60'}`}><span className="text-2xl">{AVATARS[p.avatar]}</span><div className="flex-1 min-w-0"><div className="text-sm font-bold">{p.id+1}号 {p.name}{p.isHuman?' 👤':' 🤖'}</div>{!p.alive&&<div className="text-xs text-red-500">已出局</div>}</div><span className={`text-xs px-2 py-1 rounded font-bold ${p.role==='werewolf'?'bg-red-800 text-red-200':p.role==='seer'?'bg-purple-800 text-purple-200':p.role==='witch'?'bg-teal-800 text-teal-200':p.role==='hunter'?'bg-orange-800 text-orange-200':p.role==='idiot'?'bg-pink-800 text-pink-200':'bg-green-800 text-green-200'}`}>{RM[p.role]}</span></div>)}</div></div></div>}
    <div className="grid grid-cols-4 gap-2 mb-4">{players.map(p=><PCV key={p.id} p={p}/>)}</div>
    {renderAP()}
    {showLog&&log.length>0&&<div className="mt-4 bg-gray-900 rounded-xl overflow-hidden"><button onClick={()=>setLogExpanded(!logExpanded)} className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-800/50 transition-colors"><h3 className="text-sm font-bold text-gray-400">📜 日志 ({log.length})</h3><span className={`text-gray-500 text-xs transition-transform ${logExpanded?'rotate-180':''}`}>▼</span></button>{logExpanded&&<div className="px-3 pb-3 max-h-60 overflow-y-auto">{log.map((l,i)=><div key={i} className="text-xs text-gray-500 mb-1">{l}</div>)}</div>}</div>}
  </div></div>);
}

ReactDOM.render(<App/>,document.getElementById('root'));