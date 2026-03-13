const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RM = { werewolf: '狼人', villager: '平民', seer: '预言家', witch: '女巫', hunter: '猎人', idiot: '白痴' };
const MODE_CONFIGS = {
  1: { icon: '🎯', label: '经典8人局（少狼）', desc: '2狼人 + 2神职（预言家、女巫）+ 4平民', roles: ['werewolf', 'werewolf', 'villager', 'villager', 'villager', 'villager', 'seer', 'witch'], wolfCount: 2, winRule: 'parity', specialRoles: ['seer', 'witch'] },
  2: { icon: '🏹', label: '猎人局（多狼）', desc: '3狼人 + 3神职（预言家、女巫、猎人）+ 2平民', descExtra: '🐺 屠边：狼人杀光平民或神职即可获胜', roles: ['werewolf', 'werewolf', 'werewolf', 'villager', 'villager', 'hunter', 'seer', 'witch'], wolfCount: 3, winRule: 'edge', specialRoles: ['seer', 'witch', 'hunter'] },
  3: { icon: '⚡', label: '10人速推局', desc: '3狼人 + 3神职（预言家、女巫、猎人）+ 4平民', roles: ['werewolf', 'werewolf', 'werewolf', 'villager', 'villager', 'villager', 'villager', 'seer', 'witch', 'hunter'], wolfCount: 3, winRule: 'parity', specialRoles: ['seer', 'witch', 'hunter'] },
  4: { icon: '🏟️', label: '12人标准场（竞技核心）', desc: '4狼人 + 4神职（预言家、女巫、猎人、白痴）+ 4平民', descExtra: '🐺 屠边规则：狼人杀光平民或神职即可获胜', roles: ['werewolf', 'werewolf', 'werewolf', 'werewolf', 'villager', 'villager', 'villager', 'villager', 'seer', 'witch', 'hunter', 'idiot'], wolfCount: 4, winRule: 'edge', specialRoles: ['seer', 'witch', 'hunter', 'idiot'] },
};

const rooms = new Map();

function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return out;
}

function makeRoomId() {
  let id = randomCode(6);
  while (rooms.has(id)) id = randomCode(6);
  return id;
}

function normalizePassword(password) {
  const raw = String(password || '').replace(/\D/g, '').slice(0, 6);
  return raw.length === 6 ? raw : null;
}

function defaultLobbyState() {
  const roles = MODE_CONFIGS[1].roles;
  return {
    phase: 'setup',
    gameMode: 1,
    round: 1,
    step: null,
    stepQueue: [],
    qIdx: 0,
    players: roles.map((role, i) => ({
      id: i,
      name: `玩家${i + 1}`,
      avatar: i,
      isHuman: i === 0,
      role: null,
      alive: true,
      canVote: true,
      idiotRevealed: false,
      personality: null,
    })),
    apiAutoMode: false,
    adminMode: false,
    enhanceAI: false,
    revealDeadIdentity: false,
    enableLastWords: false,
    allowNightLastWords: true,
    onlyFirstNightLW: false,
    wordLimitEnabled: false,
    wordLimitNum: 200,
    wordLimitMode: 'max',
    personalityHardcore: false,
    speechOrderMode: 3,
    speeches: [],
    votes: {},
    voteOrder: [],
    votingActive: false,
    selectedVoter: null,
    nightHumanQueue: [],
    nightHumanQIdx: -1,
    nightHumanState: null,
    seerCheckResult: null,
    hunterShotPending: null,
    lwQueue: [],
    lwQIdx: 0,
    lwContext: null,
    nightProgressPct: 0,
    nightProgressLabel: '',
    nightResultMsg: '',
    gameResult: null,
    wolfVotes: {},
    nightKill: null,
    witchHasSave: true,
    witchHasPoison: true,
    seerHistory: [],
    lastWordsList: [],
    dayVoteHistory: [],
    lastDeadIds: [],
    gameHistory: [],
    log: [],
  };
}

function createRoom({ hostSessionId, hostName, isPrivate, password }) {
  const id = makeRoomId();
  const room = {
    id,
    hostSessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isPrivate: !!isPrivate,
    password: isPrivate ? normalizePassword(password) : null,
    latestState: defaultLobbyState(),
    apiConfigs: {},
    members: new Map(),
    seatAssignments: { 0: hostSessionId },
    pendingJobs: new Map(),
  };
  room.members.set(hostSessionId, {
    sessionId: hostSessionId,
    displayName: hostName || '房主',
    socketIds: new Set(),
    joinedAt: Date.now(),
    updatedAt: Date.now(),
  });
  rooms.set(id, room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(String(roomId || '').trim().toUpperCase());
}

function ensureMember(room, sessionId, displayName) {
  if (!room.members.has(sessionId)) {
    room.members.set(sessionId, {
      sessionId,
      displayName: displayName || '玩家',
      socketIds: new Set(),
      joinedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  const member = room.members.get(sessionId);
  if (displayName && displayName.trim()) member.displayName = displayName.trim().slice(0, 24);
  member.updatedAt = Date.now();
  return member;
}

function getSeatOfSession(room, sessionId) {
  for (const [seatId, owner] of Object.entries(room.seatAssignments || {})) {
    if (owner === sessionId) return Number(seatId);
  }
  return null;
}

function getDisplayName(room, sessionId) {
  return room.members.get(sessionId)?.displayName || '玩家';
}

function getActiveSocketId(io, room, sessionId) {
  const member = room.members.get(sessionId);
  if (!member) return null;
  for (const socketId of member.socketIds) {
    if (io.sockets.sockets.has(socketId)) return socketId;
  }
  return null;
}

function getConnectedMemberCount(room) {
  let count = 0;
  for (const member of room.members.values()) {
    if (member.socketIds.size > 0) count += 1;
  }
  return count;
}

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function getModeLabel(mode) {
  return MODE_CONFIGS[mode]?.label || MODE_CONFIGS[1].label;
}

function visibleRoleForViewer(state, viewerSeat, targetSeat) {
  if (!state?.players?.[targetSeat]) return null;
  const target = state.players[targetSeat];
  if (viewerSeat === targetSeat) return target.role || null;
  if (!target.alive && state.revealDeadIdentity) return target.role || null;
  if (target.idiotRevealed) return 'idiot';
  return null;
}

function filterGameHistoryForViewer(history, player) {
  if (!Array.isArray(history) || !player) return [];
  return history.filter((entry) => {
    if (entry.includes('[玩家]')) return false;
    if (entry.includes('[夜晚-狼人]')) return player.role === 'werewolf';
    if (entry.includes('[夜晚-预言家]')) return player.role === 'seer';
    if (entry.includes('[夜晚-女巫]')) return player.role === 'witch';
    return true;
  });
}

function getAvailableSeats(room) {
  const state = room.latestState || defaultLobbyState();
  return (state.players || [])
    .filter((p) => p.isHuman)
    .map((p) => ({
      id: p.id,
      name: p.name,
      occupiedBy: room.seatAssignments[p.id] || null,
      occupiedName: room.seatAssignments[p.id] ? getDisplayName(room, room.seatAssignments[p.id]) : null,
      isHostSeat: p.id === 0,
    }));
}

function pruneSeatAssignments(room) {
  const state = room.latestState || defaultLobbyState();
  const next = {};
  if (room.hostSessionId) next[0] = room.hostSessionId;
  for (const [seatIdRaw, sessionId] of Object.entries(room.seatAssignments || {})) {
    const seatId = Number(seatIdRaw);
    if (seatId === 0) continue;
    const seat = state.players?.[seatId];
    if (!seat) continue;
    if (!seat.isHuman) continue;
    if (!room.members.has(sessionId)) continue;
    next[seatId] = sessionId;
  }
  room.seatAssignments = next;
}

function buildLobbyPlayers(room, viewerSeat) {
  const state = room.latestState || defaultLobbyState();
  return (state.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    isHuman: !!p.isHuman,
    alive: p.alive !== false,
    canVote: p.canVote !== false,
    idiotRevealed: !!p.idiotRevealed,
    occupiedByMe: viewerSeat === p.id,
    occupiedName: room.seatAssignments[p.id] ? getDisplayName(room, room.seatAssignments[p.id]) : null,
    occupied: !!room.seatAssignments[p.id],
    role: visibleRoleForViewer(state, viewerSeat, p.id),
  }));
}

function buildPrivateRoleInfo(state, seatId) {
  if (seatId === null || seatId === undefined) return null;
  const me = state.players?.[seatId];
  if (!me) return null;
  return {
    role: me.role || null,
    roleLabel: me.role ? RM[me.role] : null,
    wolfMates: me.role === 'werewolf'
      ? state.players.filter((p) => p.role === 'werewolf' && p.id !== seatId).map((p) => ({ id: p.id, name: p.name, alive: p.alive !== false }))
      : [],
    seerHistory: me.role === 'seer' ? clone(state.seerHistory || []) : [],
    witchState: me.role === 'witch' ? { hasSave: !!state.witchHasSave, hasPoison: !!state.witchHasPoison } : null,
  };
}

function aliveTargets(players, excludeIds = [], predicate = null) {
  return (players || [])
    .filter((p) => p.alive !== false && !excludeIds.includes(p.id) && (!predicate || predicate(p)))
    .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar }));
}

function buildViewerAction(room, state, sessionId, seatId) {
  if (!state) return null;
  const me = seatId !== null && seatId !== undefined ? state.players?.[seatId] : null;
  const human = me && me.isHuman;
  const currentRoleRevealSeat = Array.isArray(state.stepQueue) && typeof state.qIdx === 'number' ? state.stepQueue[state.qIdx] : null;
  const currentSpeechSeat = Array.isArray(state.stepQueue) && typeof state.qIdx === 'number' ? state.stepQueue[state.qIdx] : null;
  const currentNightSeat = Array.isArray(state.nightHumanQueue) && typeof state.nightHumanQIdx === 'number' ? state.nightHumanQueue[state.nightHumanQIdx] : null;
  const currentLwSeat = Array.isArray(state.lwQueue) && typeof state.lwQIdx === 'number' ? state.lwQueue[state.lwQIdx] : null;
  const meRole = me?.role || null;

  if (!me || !human) return null;
  if (state.gameResult) return { type: 'gameOver' };

  if (state.phase === 'roleReveal') {
    if (currentRoleRevealSeat === seatId) {
      return { type: 'roleReveal' };
    }
    return { type: 'waiting', title: '身份发放中', message: currentRoleRevealSeat === null || currentRoleRevealSeat === undefined ? '等待房主开始' : `等待 ${currentRoleRevealSeat + 1}号 玩家确认身份` };
  }

  if (state.phase === 'night') {
    if (state.nightHumanState === 'seerResult' && currentNightSeat === seatId && meRole === 'seer' && state.seerCheckResult) {
      return {
        type: 'seerResult',
        target: state.seerCheckResult.target,
        isWolf: !!state.seerCheckResult.isWolf,
      };
    }
    if (state.nightHumanState === 'action' && currentNightSeat === seatId) {
      if ((state.step === 'wolfSeer' || state.step === 'wolf' || state.step === 'werewolf') && meRole === 'werewolf') {
        return {
          type: 'nightWolf',
          targets: aliveTargets(state.players, [], (p) => p.role !== 'werewolf'),
        };
      }
      if ((state.step === 'wolfSeer' || state.step === 'seer') && meRole === 'seer') {
        return {
          type: 'nightSeer',
          targets: aliveTargets(state.players, [seatId]),
        };
      }
      if (state.step === 'witch' && meRole === 'witch') {
        const canSave = !!state.witchHasSave && state.nightKill !== null && state.nightKill !== undefined && (state.round === 1 || state.nightKill !== seatId);
        return {
          type: 'nightWitch',
          killTarget: state.nightKill,
          canSave,
          canPoison: !!state.witchHasPoison,
          targets: aliveTargets(state.players, [seatId]),
        };
      }
      return { type: 'nightIdle', message: '暂时不需要行动。' };
    }
    return { type: 'waiting', title: '夜晚进行中', message: '等待其他玩家/AI结算。' };
  }

  if (state.phase === 'lastWords') {
    if (currentLwSeat === seatId) return { type: 'lastWords' };
    return { type: 'waiting', title: '遗言阶段', message: '等待当前出局玩家发遗言。' };
  }

  if (state.phase === 'hunterShot') {
    if (state.hunterShotPending === seatId) {
      return {
        type: 'hunterShot',
        targets: aliveTargets(state.players, [seatId]),
      };
    }
    return { type: 'waiting', title: '猎人开枪', message: '等待猎人处理技能。' };
  }

  if (state.phase === 'day') {
    if (state.step === 'announce') {
      return { type: 'waiting', title: '白天开始', message: state.nightResultMsg || '等待进入发言阶段。' };
    }
    if (state.step === 'speech') {
      if (currentSpeechSeat === seatId) {
        return {
          type: 'speech',
          wordLimitEnabled: !!state.wordLimitEnabled,
          wordLimitNum: state.wordLimitNum || 0,
          wordLimitMode: state.wordLimitMode || 'max',
        };
      }
      return { type: 'waiting', title: '发言阶段', message: currentSpeechSeat === null || currentSpeechSeat === undefined ? '等待发言开始' : `等待 ${currentSpeechSeat + 1}号 发言` };
    }
    if (state.step === 'vote' && state.votingActive) {
      if (state.apiAutoMode) {
        const canVote = me.alive !== false && me.canVote !== false && state.votes?.[seatId] === undefined;
        if (canVote) {
          return {
            type: 'vote',
            targets: aliveTargets(state.players, [seatId]),
            simultaneous: true,
          };
        }
        return { type: 'waiting', title: '投票阶段', message: state.votes?.[seatId] !== undefined ? '你已提交投票，等待其他玩家/AI。' : '等待投票结算。' };
      }
      if (state.selectedVoter === seatId) {
        return {
          type: 'vote',
          targets: aliveTargets(state.players, [seatId]),
          simultaneous: false,
        };
      }
      return { type: 'waiting', title: '投票阶段', message: state.selectedVoter === null || state.selectedVoter === undefined ? '等待房主选定投票玩家。' : `等待 ${state.selectedVoter + 1}号 投票` };
    }
    return { type: 'waiting', title: '白天进行中', message: '等待结算。' };
  }

  if (state.phase === 'dayResult') {
    return { type: 'waiting', title: '结算中', message: '等待进入下一轮。' };
  }

  return null;
}

function buildViewerState(room, sessionId) {
  const state = room.latestState || defaultLobbyState();
  const seatId = getSeatOfSession(room, sessionId);
  const viewerSeat = seatId;
  const me = viewerSeat !== null && viewerSeat !== undefined ? state.players?.[viewerSeat] : null;
  const privateRoleInfo = buildPrivateRoleInfo(state, viewerSeat);
  const players = (state.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    isHuman: !!p.isHuman,
    alive: p.alive !== false,
    canVote: p.canVote !== false,
    idiotRevealed: !!p.idiotRevealed,
    occupiedByMe: room.seatAssignments[p.id] === sessionId,
    occupiedName: room.seatAssignments[p.id] ? getDisplayName(room, room.seatAssignments[p.id]) : null,
    occupied: !!room.seatAssignments[p.id],
    role: visibleRoleForViewer(state, viewerSeat, p.id),
  }));
  const filteredHistory = me ? filterGameHistoryForViewer(state.gameHistory || [], me) : (state.gameHistory || []).filter((line) => !line.includes('[玩家]') && !line.includes('[夜晚-狼人]') && !line.includes('[夜晚-预言家]') && !line.includes('[夜晚-女巫]'));
  const votesList = Object.entries(state.votes || {}).map(([from, to]) => ({
    from: Number(from),
    to,
  }));
  return {
    phase: state.phase,
    step: state.step,
    round: state.round,
    gameMode: state.gameMode,
    gameLabel: getModeLabel(state.gameMode),
    apiAutoMode: !!state.apiAutoMode,
    adminMode: !!state.adminMode,
    gameResult: state.gameResult,
    nightResultMsg: state.nightResultMsg || '',
    players,
    speeches: clone(state.speeches || []),
    votes: votesList,
    voteOrder: clone(state.voteOrder || []),
    votingActive: !!state.votingActive,
    selectedVoter: state.selectedVoter ?? null,
    lastWordsList: clone(state.lastWordsList || []),
    dayVoteHistory: clone(state.dayVoteHistory || []),
    gameHistory: filteredHistory.slice(-120),
    revealDeadIdentity: !!state.revealDeadIdentity,
    enableLastWords: !!state.enableLastWords,
    allowNightLastWords: !!state.allowNightLastWords,
    onlyFirstNightLW: !!state.onlyFirstNightLW,
    wordLimitEnabled: !!state.wordLimitEnabled,
    wordLimitNum: state.wordLimitNum || 0,
    wordLimitMode: state.wordLimitMode || 'max',
    personalityHardcore: !!state.personalityHardcore,
    speechOrderMode: state.speechOrderMode || 3,
    nightProgressPct: state.nightProgressPct || 0,
    nightProgressLabel: state.nightProgressLabel || '',
    roomPendingAiCount: room.pendingJobs.size,
    mySeat: seatId,
    privateRoleInfo,
    action: buildViewerAction(room, state, sessionId, seatId),
  };
}

function roomSummaryForUser(room, sessionId) {
  const state = room.latestState || defaultLobbyState();
  const isHost = room.hostSessionId === sessionId;
  return {
    id: room.id,
    isPrivate: room.isPrivate,
    roomPassword: isHost ? room.password : null,
    gameStarted: state.phase !== 'setup',
    hostConnected: !!getActiveSocketId(io, room, room.hostSessionId),
    isHost,
    mySeat: getSeatOfSession(room, sessionId),
    pendingAiCount: room.pendingJobs.size,
    availableSeats: getAvailableSeats(room),
    members: Array.from(room.members.values()).map((member) => ({
      sessionId: member.sessionId,
      displayName: member.displayName,
      connected: member.socketIds.size > 0,
      seatId: getSeatOfSession(room, member.sessionId),
      isHost: member.sessionId === room.hostSessionId,
    })),
    latestStateSummary: {
      gameMode: state.gameMode,
      gameLabel: getModeLabel(state.gameMode),
      apiAutoMode: !!state.apiAutoMode,
      adminMode: !!state.adminMode,
      phase: state.phase,
      players: buildLobbyPlayers(room, getSeatOfSession(room, sessionId)),
      settings: {
        revealDeadIdentity: !!state.revealDeadIdentity,
        enableLastWords: !!state.enableLastWords,
        allowNightLastWords: !!state.allowNightLastWords,
        onlyFirstNightLW: !!state.onlyFirstNightLW,
        wordLimitEnabled: !!state.wordLimitEnabled,
        wordLimitNum: state.wordLimitNum || 0,
        wordLimitMode: state.wordLimitMode || 'max',
        personalityHardcore: !!state.personalityHardcore,
        speechOrderMode: state.speechOrderMode || 3,
        enhanceAI: !!state.enhanceAI,
      },
    },
    viewer: buildViewerState(room, sessionId),
  };
}

function emitRoomState(room) {
  room.updatedAt = Date.now();
  for (const member of room.members.values()) {
    const payload = { room: roomSummaryForUser(room, member.sessionId) };
    for (const socketId of member.socketIds) {
      io.to(socketId).emit('room:state', payload);
    }
  }
}

function listPublicRooms() {
  return Array.from(rooms.values())
    .filter((room) => !room.isPrivate)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50)
    .map((room) => ({
      id: room.id,
      gameStarted: room.latestState?.phase !== 'setup',
      hostName: getDisplayName(room, room.hostSessionId),
      connectedCount: getConnectedMemberCount(room),
      totalSeats: room.latestState?.players?.length || MODE_CONFIGS[1].roles.length,
      humanSeats: (room.latestState?.players || []).filter((p) => p.isHuman).length,
      gameLabel: getModeLabel(room.latestState?.gameMode || 1),
      apiAutoMode: !!room.latestState?.apiAutoMode,
      updatedAt: room.updatedAt,
    }));
}

function parseApiResponse(data) {
  if (data?.choices?.[0]?.message?.content) return data.choices[0].message.content;
  if (data?.content?.[0]?.text) return data.content[0].text;
  if (typeof data?.response === 'string') return data.response;
  if (data?.output?.text) return data.output.text;
  if (typeof data?.result === 'string') return data.result;
  if (data?.result) return JSON.stringify(data.result);
  throw new Error(`无法解析API响应: ${JSON.stringify(data).slice(0, 300)}`);
}

async function callExternalApi(config, prompt, signal) {
  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      max_tokens: config.maxTokens || 65536,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return parseApiResponse(data);
}

function cleanupJob(room, requestId) {
  room.pendingJobs.delete(requestId);
  emitRoomState(room);
}

function abortJobGroup(room, group, reason = 'cancelled') {
  if (!group || group.settled) return;
  group.settled = true;
  for (const attempt of group.attempts.values()) {
    try { attempt.controller.abort(reason); } catch (error) { /* noop */ }
  }
  const hostSocketId = getActiveSocketId(io, room, room.hostSessionId);
  if (hostSocketId) io.to(hostSocketId).emit('ai:cancelled', { requestId: group.requestId, reason });
  cleanupJob(room, group.requestId);
}

function maybeFailGroup(room, group) {
  if (group.settled) return;
  const attempts = Array.from(group.attempts.values());
  if (attempts.some((attempt) => attempt.status === 'running')) return;
  group.settled = true;
  const lastError = attempts.reverse().find((attempt) => attempt.error)?.error || 'AI请求失败';
  const hostSocketId = getActiveSocketId(io, room, room.hostSessionId);
  if (hostSocketId) io.to(hostSocketId).emit('ai:error', { requestId: group.requestId, error: String(lastError) });
  cleanupJob(room, group.requestId);
}

function settleGroupSuccess(room, group, response, attemptId) {
  if (group.settled) return;
  group.settled = true;
  for (const [id, attempt] of group.attempts.entries()) {
    if (id !== attemptId) {
      try { attempt.controller.abort('winner-settled'); } catch (error) { /* noop */ }
    }
  }
  const hostSocketId = getActiveSocketId(io, room, room.hostSessionId);
  if (hostSocketId) {
    io.to(hostSocketId).emit('ai:result', {
      requestId: group.requestId,
      playerId: group.playerId,
      response,
      attemptId,
    });
  }
  cleanupJob(room, group.requestId);
}

function startJobAttempt(room, group) {
  if (!group || group.settled) return;
  const attemptId = `${group.requestId}_${group.nextAttempt++}`;
  const controller = new AbortController();
  const attempt = {
    attemptId,
    controller,
    status: 'running',
    startedAt: Date.now(),
    error: null,
  };
  group.attempts.set(attemptId, attempt);
  emitRoomState(room);
  callExternalApi(group.config, group.prompt, controller.signal)
    .then((response) => {
      attempt.status = 'done';
      settleGroupSuccess(room, group, response, attemptId);
    })
    .catch((error) => {
      if (controller.signal.aborted) {
        attempt.status = 'aborted';
        attempt.error = String(error?.message || error || 'aborted');
      } else {
        attempt.status = 'error';
        attempt.error = String(error?.message || error || 'AI请求失败');
      }
      maybeFailGroup(room, group);
    });
}

function createAiJob(room, { requestId, playerId, prompt }) {
  const config = room.apiConfigs?.[playerId];
  if (!config?.apiKey || !config?.apiUrl) throw new Error(`${playerId + 1}号未配置API`);
  const group = {
    requestId,
    playerId,
    prompt,
    config,
    attempts: new Map(),
    nextAttempt: 1,
    settled: false,
  };
  room.pendingJobs.set(requestId, group);
  startJobAttempt(room, group);
  return group;
}

function accelerateRoomJobs(room) {
  for (const group of room.pendingJobs.values()) {
    if (!group.settled) startJobAttempt(room, group);
  }
  emitRoomState(room);
}

function cancelRoomJobs(room, reason = 'room-cancelled') {
  for (const group of Array.from(room.pendingJobs.values())) abortJobGroup(room, group, reason);
  emitRoomState(room);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

io.use((socket, next) => {
  const sessionId = String(socket.handshake.auth?.sessionId || '').trim();
  const displayName = String(socket.handshake.auth?.displayName || '').trim().slice(0, 24);
  if (!sessionId) return next(new Error('missing-session-id'));
  socket.data.sessionId = sessionId;
  socket.data.displayName = displayName || '玩家';
  next();
});

function leaveRoomCompletely(socket, room) {
  const sessionId = socket.data.sessionId;
  const member = room.members.get(sessionId);
  if (!member) return;
  member.socketIds.delete(socket.id);
  if (member.socketIds.size === 0) {
    if (sessionId !== room.hostSessionId) {
      const seatId = getSeatOfSession(room, sessionId);
      if (seatId !== null) delete room.seatAssignments[seatId];
    }
  }
  socket.leave(room.id);
  emitRoomState(room);
}

io.on('connection', (socket) => {
  socket.on('lobby:list', (ack) => {
    if (typeof ack === 'function') ack({ ok: true, rooms: listPublicRooms() });
  });

  socket.on('profile:update', ({ displayName }, ack) => {
    const name = String(displayName || '').trim().slice(0, 24) || '玩家';
    socket.data.displayName = name;
    for (const room of rooms.values()) {
      const member = room.members.get(socket.data.sessionId);
      if (member) {
        member.displayName = name;
        member.updatedAt = Date.now();
        emitRoomState(room);
      }
    }
    if (typeof ack === 'function') ack({ ok: true, displayName: name });
  });

  socket.on('room:create', ({ isPrivate, password }, ack) => {
    try {
      const privateFlag = !!isPrivate;
      const normalizedPassword = privateFlag ? normalizePassword(password) : null;
      if (privateFlag && !normalizedPassword) {
        if (typeof ack === 'function') ack({ ok: false, error: '私人房间必须设置6位数字密码。' });
        return;
      }
      const room = createRoom({
        hostSessionId: socket.data.sessionId,
        hostName: socket.data.displayName,
        isPrivate: privateFlag,
        password: normalizedPassword,
      });
      const member = ensureMember(room, socket.data.sessionId, socket.data.displayName);
      member.socketIds.add(socket.id);
      socket.join(room.id);
      emitRoomState(room);
      if (typeof ack === 'function') ack({ ok: true, roomId: room.id });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error?.message || '创建房间失败' });
    }
  });

  socket.on('room:join', ({ roomId, password }, ack) => {
    const room = getRoom(roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: '房间不存在。' });
      return;
    }
    if (room.isPrivate && room.password !== normalizePassword(password)) {
      if (typeof ack === 'function') ack({ ok: false, error: '房间密码错误。' });
      return;
    }
    const member = ensureMember(room, socket.data.sessionId, socket.data.displayName);
    member.socketIds.add(socket.id);
    socket.join(room.id);
    emitRoomState(room);
    if (typeof ack === 'function') ack({ ok: true, roomId: room.id });
  });

  socket.on('room:leave', ({ roomId }, ack) => {
    const room = getRoom(roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    if (socket.data.sessionId === room.hostSessionId) {
      cancelRoomJobs(room, 'host-left-room');
      rooms.delete(room.id);
      io.to(room.id).emit('room:closed', { reason: '房主已离开，房间已关闭。' });
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    leaveRoomCompletely(socket, room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('room:claimSeat', ({ roomId, seatId }, ack) => {
    const room = getRoom(roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: '房间不存在。' });
      return;
    }
    const state = room.latestState || defaultLobbyState();
    const seat = state.players?.[seatId];
    if (!seat || !seat.isHuman) {
      if (typeof ack === 'function') ack({ ok: false, error: '该位置当前不可加入。' });
      return;
    }
    if (state.phase !== 'setup') {
      if (typeof ack === 'function') ack({ ok: false, error: '游戏已开始，无法换座。' });
      return;
    }
    if (seatId === 0 && socket.data.sessionId !== room.hostSessionId) {
      if (typeof ack === 'function') ack({ ok: false, error: '1号位为房主专属。' });
      return;
    }
    const owner = room.seatAssignments[seatId];
    if (owner && owner !== socket.data.sessionId) {
      if (typeof ack === 'function') ack({ ok: false, error: '该位置已被占用。' });
      return;
    }
    const previousSeat = getSeatOfSession(room, socket.data.sessionId);
    if (previousSeat !== null && previousSeat !== 0) delete room.seatAssignments[previousSeat];
    room.seatAssignments[seatId] = socket.data.sessionId;
    emitRoomState(room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('room:releaseSeat', ({ roomId }, ack) => {
    const room = getRoom(roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    const seatId = getSeatOfSession(room, socket.data.sessionId);
    if (seatId !== null && seatId !== 0) delete room.seatAssignments[seatId];
    emitRoomState(room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('room:hostSnapshot', ({ roomId, snapshot }, ack) => {
    const room = getRoom(roomId);
    if (!room || room.hostSessionId !== socket.data.sessionId) {
      if (typeof ack === 'function') ack({ ok: false, error: '无权限。' });
      return;
    }
    room.latestState = clone(snapshot || defaultLobbyState());
    if (room.latestState?.players?.[0]) room.latestState.players[0].isHuman = true;
    pruneSeatAssignments(room);
    emitRoomState(room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('room:setApiConfigs', ({ roomId, configs }, ack) => {
    const room = getRoom(roomId);
    if (!room || room.hostSessionId !== socket.data.sessionId) {
      if (typeof ack === 'function') ack({ ok: false, error: '无权限。' });
      return;
    }
    room.apiConfigs = clone(configs || {});
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('room:action', ({ roomId, action }, ack) => {
    const room = getRoom(roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: '房间不存在。' });
      return;
    }
    const seatId = getSeatOfSession(room, socket.data.sessionId);
    if (action?.seatId !== undefined && action?.seatId !== null && Number(action.seatId) !== seatId) {
      if (typeof ack === 'function') ack({ ok: false, error: '座位不匹配。' });
      return;
    }
    const hostSocketId = getActiveSocketId(io, room, room.hostSessionId);
    if (!hostSocketId) {
      if (typeof ack === 'function') ack({ ok: false, error: '房主当前不在线。' });
      return;
    }
    io.to(hostSocketId).emit('room:action', { sessionId: socket.data.sessionId, action });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('room:accelerateAi', ({ roomId }, ack) => {
    const room = getRoom(roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: '房间不存在。' });
      return;
    }
    const seatId = getSeatOfSession(room, socket.data.sessionId);
    const me = seatId !== null && room.latestState?.players?.[seatId] ? room.latestState.players[seatId] : null;
    if (!me || !me.isHuman) {
      if (typeof ack === 'function') ack({ ok: false, error: '只有人类玩家可以加速。' });
      return;
    }
    accelerateRoomJobs(room);
    if (typeof ack === 'function') ack({ ok: true, pendingAiCount: room.pendingJobs.size });
  });

  socket.on('room:cancelAi', ({ roomId }, ack) => {
    const room = getRoom(roomId);
    if (!room || room.hostSessionId !== socket.data.sessionId) {
      if (typeof ack === 'function') ack({ ok: false, error: '无权限。' });
      return;
    }
    cancelRoomJobs(room, 'host-cancelled');
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('ai:request', ({ roomId, requestId, playerId, prompt }, ack) => {
    const room = getRoom(roomId);
    if (!room || room.hostSessionId !== socket.data.sessionId) {
      if (typeof ack === 'function') ack({ ok: false, error: '无权限。' });
      return;
    }
    try {
      if (!requestId) throw new Error('缺少requestId');
      if (room.pendingJobs.has(requestId)) abortJobGroup(room, room.pendingJobs.get(requestId), 'request-replaced');
      createAiJob(room, { requestId, playerId, prompt });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error?.message || 'AI请求失败' });
    }
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const member = room.members.get(socket.data.sessionId);
      if (!member) continue;
      if (member.socketIds.has(socket.id)) {
        member.socketIds.delete(socket.id);
        member.updatedAt = Date.now();
        emitRoomState(room);
      }
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of Array.from(rooms.values())) {
    const active = Array.from(room.members.values()).some((member) => member.socketIds.size > 0);
    if (!active && now - room.updatedAt > 1000 * 60 * 60 * 6) {
      cancelRoomJobs(room, 'room-expired');
      rooms.delete(room.id);
    }
  }
}, 1000 * 60 * 10);

server.listen(PORT, () => {
  console.log(`AI Werewolf server listening on :${PORT}`);
});
