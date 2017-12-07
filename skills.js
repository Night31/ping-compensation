const JITTER_COMPENSATION	= true,
	SKILL_RETRY_COUNT		= 2,		//	Number of times to retry each skill (0 = disabled). Recommended 1-3.
	SKILL_RETRY_MS			= 30,		/*	Time to wait between each retry.
											SKILL_RETRY_MS * SKILL_RETRY_COUNT should be under 100, otherwise skills may go off twice.
										*/
	SKILL_RETRY_JITTERCOMP	= 15,		//	Skills that support retry will be sent this much earlier than estimated by jitter compensation.
	SKILL_RETRY_ALWAYS		= false,	//	Setting this to true will reduce ghosting for extremely short skills, but may cause other skills to fail.
	SKILL_DELAY_ON_FAIL		= true,		//	Basic initial desync compensation. Useless at low ping (<50ms).
	SERVER_TIMEOUT			= 200,		/*	This number is added to your maximum ping + skill retry period to set the failure threshold for skills.
											If animations are being cancelled while damage is still applied, increase this number.
										*/
	FORCE_CLIP_STRICT		= true,		/*	Set this to false for smoother, less accurate iframing near walls.
											Warning: Will cause occasional clipping through gates when disabled. Do NOT abuse this.
										*/
	DEFEND_SUCCESS_STRICT	= true,		//	Set this to false to see Brawler's Perfect Block icon at very high ping (warning: may crash client).
	DEBUG					= false,
	DEBUG_LOC				= false,
	DEBUG_PROJECTILE		= false,
	DEBUG_GLYPH				= false

const {protocol, sysmsg} = require('tera-data-parser'),
	Long = require('long'),
	Command = require('command'),
	Ping = require('./ping'),
	AbnormalityPrediction = require('./abnormalities'),
	skills = require('./config/skills'),
	silence = require('./config/silence').reduce((map, value) => { // Convert array to object for fast lookup
		map[value] = true
		return map
	}, {})

const INTERRUPT_TYPES = {
	'retaliate': 5,
	'lockonCast': 36
}

const Flags = {
	Player: 0x04000000,
	CC: 0x08000000
}

module.exports = function SkillPrediction(dispatch) {
	const command = Command(dispatch),
		ping = Ping(dispatch),
		abnormality = AbnormalityPrediction(dispatch)

	let sending = false,
		skillsCache = null,
		gameId = null,
		templateId = 0,
		race = -1,
		job = -1,
		vehicleEx = null,
		aspd = 1,
		currentGlyphs = null,
		currentStamina = 0,
		alive = false,
		inCombat = false,
		inventoryHook = null,
		inventory = null,
		equippedWeapon = false,
		partyMembers = null,
		delayNext = 0,
		delayNextTimeout = null,
		actionNumber = 0x80000000,
		currentLocation = null,
		lastStartTime = 0,
		lastStartLocation = null,
		lastEndLocation = null,
		oopsLocation = null,
		currentAction = null,
		serverAction = null,
		serverConfirmedAction = false,
		queuedNotifyLocation = [],
		clientProjectileId = 0,
		clientProjectiles = {},
		clientProjectileHits = [],
		serverProjectiles = {}
		storedCharge = 0,
		lastEndSkill = 0,
		lastEndType = 0,
		lastEndedId = 0,
		serverTimeout = null,
		effectsTimeouts = [],
		stageEnd = null,
		stageEndTime = 0,
		stageEndTimeout = null,
		debugActionTime = 0

	command.add('ping', () => {
		command.message(`Ping: ${ping.history.length ? `Avg=${Math.round(ping.avg)} Min=${ping.min} Max=${ping.max} Jitter=${ping.max - ping.min} Samples=${ping.history.length}` : '???'}`)
	})

	dispatch.hook('S_LOGIN', 9, event => {
		skillsCache = {}
		;({gameId, templateId} = event)
		race = Math.floor((templateId - 10101) / 100)
		job = (templateId - 10101) % 100

		if(DEBUG) console.log(`Race=${race} Class=${job}`)

		hookInventory()
	})

	dispatch.hook('S_LOAD_TOPO', 'raw', () => {
		vehicleEx = null
		currentAction = null
		serverAction = null
		lastEndSkill = 0
		lastEndType = 0
		lastEndedId = 0
		sendActionEnd(37)
	})

	dispatch.hook('S_PLAYER_STAT_UPDATE', 8, event => {
		// Newer classes use a different speed algorithm
		aspd = (event.attackSpeed + event.attackSpeedBonus) / (job >= 8 ? 100 : event.attackSpeed)
		currentStamina = event.stamina
	})

	dispatch.hook('S_CREST_INFO', 1, event => {
		currentGlyphs = {}

		for(let glyph of event.glyphs)
			currentGlyphs[glyph.id] = glyph.enabled
	})

	dispatch.hook('S_CREST_APPLY', 1, event => {
		if(DEBUG_GLYPH) console.log('Glyph', event.id, event.enabled)

		currentGlyphs[event.id] = event.enabled
	})

	dispatch.hook('S_PLAYER_CHANGE_STAMINA', 1, event => { currentStamina = event.current })

	dispatch.hook('S_SPAWN_ME', 1, event => { alive = event.alive })

	dispatch.hook('S_CREATURE_LIFE', 1, event => {
		if(isMe(event.target)) {
			alive = event.alive

			if(!alive) {
				clearStage()
				oopsLocation = currentAction = serverAction = null
			}
		}
	})

	dispatch.hook('S_USER_STATUS', 1, event => {
		if(event.target.equals(gameId)) {
			inCombat = event.status == 1

			if(!inCombat) hookInventory()
			else if(!inventory && inventoryHook) {
				dispatch.unhook(inventoryHook)
				inventoryHook = null
			}
		}
	})

	function hookInventory() {
		if(!inventoryHook) inventoryHook = dispatch.hook('S_INVEN', 5, event => {
			inventory = event.first ? event.items : inventory.concat(event.items)

			if(!event.more) {
				equippedWeapon = false

				for(let item of inventory)
					if(item.slot == 1) {
						equippedWeapon = true
						break
					}

				inventory = null

				if(inCombat) {
					dispatch.unhook(inventoryHook)
					inventoryHook = null
				}
			}
		})
	}

	dispatch.hook('S_PARTY_MEMBER_LIST', 1, event => {
		partyMembers = []

		for(let member of event.members)
			if(!member.cID.equals(gameId))
				partyMembers.push(member.cID)
	})

	dispatch.hook('S_LEAVE_PARTY', () => { partyMembers = null })

	dispatch.hook('S_MOUNT_VEHICLE_EX', 1, event => {
		if(event.target.equals(gameId)) vehicleEx = event.vehicle
	})

	dispatch.hook('S_UNMOUNT_VEHICLE_EX', 1, event => {
		if(event.target.equals(gameId)) vehicleEx = null
	})

	dispatch.hook('C_PLAYER_LOCATION', 1, event => {
		if(DEBUG_LOC) console.log('Location %d %d (%d %d %d %d) > (%d %d %d)', event.type, event.speed, Math.round(event.x1), Math.round(event.y1), Math.round(event.z1), event.w, Math.round(event.x2), Math.round(event.y2), Math.round(event.z2))

		if(currentAction) {
			let info = skillInfo(currentAction.skill)

			if(info && (info.distance || info.type == 'dynamicDistance')) return false
		}

		currentLocation = {
			// This is not correct, but the midpoint location seems to be "close enough" for the client to not teleport the player
			x: (event.x1 + event.x2) / 2,
			y: (event.y1 + event.y2) / 2,
			z: (event.z1 + event.z2) / 2,
			w: event.w
		}
	})

	dispatch.hook('C_NOTIFY_LOCATION_IN_ACTION', 1, notifyLocation.bind(null, 'C_NOTIFY_LOCATION_IN_ACTION', 1))
	dispatch.hook('C_NOTIFY_LOCATION_IN_DASH', 1, notifyLocation.bind(null, 'C_NOTIFY_LOCATION_IN_DASH', 1))

	function notifyLocation(type, version, event) {
		if(DEBUG_LOC) console.log('-> %s %s %d (%d %d %d %d)', type, skillId(event.skill), event.stage, Math.round(event.x), Math.round(event.y), Math.round(event.z), event.w)

		currentLocation = {
			x: event.x,
			y: event.y,
			z: event.z,
			w: event.w,
			inAction: true
		}

		let info = skillInfo(event.skill)
		// The server rejects and logs packets with an incorrect skill, so if a skill has multiple possible IDs then we wait for a response
		if(info && (info.chains || info.hasChains))
			if(serverConfirmedAction) {
				if(!serverAction) return false
				else if(event.skill !== serverAction.skill) {
					event.skill = serverAction.skill
					return true
				}
			}
			else {
				queuedNotifyLocation.push([type, version, event])
				return false
			}
	}

	function dequeueNotifyLocation(skill) {
		if(queuedNotifyLocation.length) {
			if(skill)
				for(let [type, version, event] of queuedNotifyLocation) {
					event.skill = skill
					dispatch.toServer(type, version, event)
				}

			queuedNotifyLocation = []
		}
	}

	for(let packet of [
			['C_START_SKILL', 3],
			['C_START_TARGETED_SKILL', 3],
			['C_START_COMBO_INSTANT_SKILL', 1],
			['C_START_INSTANCE_SKILL', 1],
			['C_START_INSTANCE_SKILL_EX', 2],
			['C_PRESS_SKILL', 1],
			['C_NOTIMELINE_SKILL', 1]
		])
		dispatch.hook(packet[0], 'raw', {order: -10, filter: {fake: null}}, startSkill.bind(null, ...packet))

	function startSkill(type, version, code, data) {
		if(sending) return

		let event = protocol.parse(dispatch.base.protocolVersion, type, version, data = Buffer.from(data)),
			info = skillInfo(event.skill),
			delay = 0

		if(delayNext && Date.now() <= stageEndTime) {
			delay = delayNext

			if(info && !info.noRetry && SKILL_RETRY_COUNT) {
				delay -= SKILL_RETRY_JITTERCOMP

				if(delay < 0) delay = 0
			}
		}

		if(DEBUG) {
			let strs = ['->', type, skillId(event.skill)]

			if(type == 'C_START_SKILL') strs.push(...[event.unk ? 1 : 0, event.moving ? 1 : 0, event.continue ? 1 : 0])
			if(type == 'C_PRESS_SKILL') strs.push(event.start)
			else if(type == 'C_START_TARGETED_SKILL') {
				let tmp = []

				for(let e of event.targets) tmp.push([e.id.toString(), e.unk].join(' '))

				strs.push('[' + tmp.join(', ') + ']')
			}

			if(DEBUG_LOC) {
				strs.push(...[event.w + '\xb0', '(' + Math.round(event.x), Math.round(event.y), Math.round(event.z) + ')'])

				if(type == 'C_START_SKILL' || type == 'C_START_TARGETED_SKILL' || type == 'C_START_INSTANCE_SKILL_EX')
					strs.push(...['>', '(' + Math.round(event.toX), Math.round(event.toY), Math.round(event.toZ) + ')'])
			}

			if(delay) strs.push('DELAY=' + delay)

			debug(strs.join(' '))
		}

		clearTimeout(delayNextTimeout)

		if(delay) {
			delayNextTimeout = setTimeout(handleStartSkill, delay, type, event, info, data, true)
			return false
		}

		return handleStartSkill(type, event, info, data)
	}

	function handleStartSkill(type, event, info, data, send) {
		serverConfirmedAction = false
		dequeueNotifyLocation()
		delayNext = 0

		let specialLoc = type == 'C_START_SKILL' || type == 'C_START_TARGETED_SKILL' || type == 'C_START_INSTANCE_SKILL_EX'

		if(!info) {
			if(type != 'C_PRESS_SKILL' || event.start)
				// Sometimes invalid (if this skill can't be used, but we have no way of knowing that)
				if(type != 'C_NOTIMELINE_SKILL') updateLocation(event, false, specialLoc)

			if(send) toServerLocked(data)
			return
		}

		let skill = event.skill,
			skillBase = Math.floor((skill - 0x4000000) / 10000),
			interruptType = 0

		if(type == 'C_PRESS_SKILL' && !event.start) {
			if(currentAction && currentAction.skill == skill) {
				if(info.type == 'hold' || info.type == 'holdInfinite') {
					updateLocation(event)

					if(info.chainOnRelease) {
						sendActionEnd(11)

						info = skillInfo(skill = modifyChain(skill, info.chainOnRelease))
						if(!info) {
							if(send) toServerLocked(data)
							return
						}

						startAction({
							skill,
							info,
							stage: 0,
							speed: info.fixedSpeed || aspd * (info.speed || 1)
						})
					}
					else if(info.length) {
						let length = lastStartTime + info.length - Date.now()
						if(length > 0) {
							stageEnd = sendActionEnd.bind(null, 51, info.distance)
							stageEndTime = Date.now() + length
							stageEndTimeout = setTimeout(stageEnd, length)
						}
						else sendActionEnd(51)
					}
					else sendActionEnd(10)
				}
				else if(info.type == 'charging') grantCharge(skill, info, currentAction.stage)
			}
			else if(info.type == 'grantCharge') grantCharge(skill, info, storedCharge)

			if(send) toServerLocked(data)
			return
		}

		if(!alive || abnormality.inMap(silence)) {
			sendCannotStartSkill(event.skill)
			return false
		}

		if(!equippedWeapon) {
			sendCannotStartSkill(event.skill)
			sendSystemMessage('SMT_BATTLE_SKILL_NEED_WEAPON')
			return false
		}

		if(currentAction) {
			if(currentAction.skill & Flags.CC && (currentAction.skill & 0xffffff !== templateId * 100 + 2 || info.type !== 'retaliate')) {
				sendCannotStartSkill(event.skill)
				return false
			}

			let currentSkill = currentAction.skill - 0x4000000,
				currentSkillBase = Math.floor(currentSkill / 10000),
				currentSkillSub = currentSkill % 100

			// 6190XXXX = Pushback(?) - TODO: reproduce and log flags
			if(currentSkillBase == 6190) {
				sendCannotStartSkill(event.skill)
				return false
			}

			// Some skills are bugged clientside and can interrupt the wrong skills, so they need to be flagged manually
			if(info.noInterrupt && (info.noInterrupt.includes(currentSkillBase) || info.noInterrupt.includes(currentSkillBase + '-' + currentSkillSub))) {
				let canInterrupt = false

				if(info.interruptibleWithAbnormal)
					for(let abnormal in info.interruptibleWithAbnormal)
						if(abnormality.exists(abnormal) && currentSkillBase == info.interruptibleWithAbnormal[abnormal])
							canInterrupt = true

				if(!canInterrupt) {
					sendCannotStartSkill(event.skill)
					return false
				}
			}

			let chain = get(info, 'chains', currentSkillBase + '-' + currentSkillSub) || get(info, 'chains', currentSkillBase)

			if(chain !== undefined) {
				if(chain === null) {
					updateLocation(event, false, specialLoc)
					sendActionEnd(4)
					if(send) toServerLocked(data)
					return
				}

				skill = modifyChain(skill, chain)
				interruptType = INTERRUPT_TYPES[info.type] || 4
			}
			else interruptType = INTERRUPT_TYPES[info.type] || 6

			if(info.type == 'storeCharge') storedCharge = currentAction.stage
		}

		if(info.onlyDefenceSuccess)
			if(currentAction && currentAction.defendSuccess) interruptType = 3
			else {
				sendCannotStartSkill(event.skill)
				sendSystemMessage('SMT_SKILL_ONLY_DEFENCE_SUCCESS')
				return false
			}

		if(info.onlyTarget && event.targets[0].id.equals(0)) {
			sendCannotStartSkill(event.skill)
			return false
		}

		// Skill override (chain)
		if(skill != event.skill) {
			info = skillInfo(skill)
			if(!info) {
				if(type != 'C_NOTIMELINE_SKILL') updateLocation(event, false, specialLoc)

				if(send) toServerLocked(data)
				return
			}
		}

		// TODO: System Message
		if(info.requiredBuff) {
			if(Array.isArray(info.requiredBuff)) {
				let found = false

				for(let buff of info.requiredBuff)
					if(abnormality.exists(buff)) {
						found = true
						break
					}

				if(!found) {
					sendCannotStartSkill(event.skill)
					return false
				}
			}
			else if(!abnormality.exists(info.requiredBuff)) {
				sendCannotStartSkill(event.skill)
				return false
			}
		}

		if(type != 'C_NOTIMELINE_SKILL') updateLocation(event, false, specialLoc)
		lastStartLocation = currentLocation

		let abnormalSpeed = 1,
			chargeSpeed = 0,
			distanceMult = 1

		if(info.abnormals)
			for(let id in info.abnormals)
				if(abnormality.exists(id)) {
					let abnormal = info.abnormals[id]

					if(abnormal.speed) abnormalSpeed *= abnormal.speed
					if(abnormal.chargeSpeed) chargeSpeed += abnormal.chargeSpeed
					if(abnormal.chain) skill = modifyChain(skill, abnormal.chain)
					if(abnormal.skill) skill = 0x4000000 + abnormal.skill
				}

		// Skill override (abnormal)
		if(skill != event.skill) {
			info = skillInfo(skill)
			if(!info) {
				if(send) toServerLocked(data)
				return
			}
		}

		if(interruptType) event.continue ? clearStage() : sendActionEnd(interruptType)

		// Finish calculations and send the final skill
		let speed = info.fixedSpeed || aspd * (info.speed || 1) * abnormalSpeed,
			movement = null,
			stamina = info.stamina

		if(info.glyphs)
			for(let id in info.glyphs)
				if(currentGlyphs[id]) {
					let glyph = info.glyphs[id]

					if(glyph.speed) speed *= glyph.speed
					if(glyph.chargeSpeed) chargeSpeed += glyph.chargeSpeed
					if(glyph.movement) movement = glyph.movement
					if(glyph.distance) distanceMult *= glyph.distance
					if(glyph.stamina) stamina += glyph.stamina
				}

		if(stamina) {
			if(currentStamina < stamina) {
				sendCannotStartSkill(event.skill)
				//dispatch.toClient('S_SYSTEM_MESSAGE', 1, { message: '@' + sysmsg.map.name['SMT_BATTLE_SKILL_FAIL_LOW_STAMINA'] })
				return false
			}

			if(info.instantStamina) currentStamina -= stamina
		}

		startAction({
			skill,
			info,
			stage: 0,
			speed,
			chargeSpeed,
			movement,
			moving: type == 'C_START_SKILL' && event.moving == 1,
			distanceMult,
			targetLoc: specialLoc ? {
				x: event.toX,
				y: event.toY,
				z: event.toZ
			} : null
		})

		if(send) toServerLocked(data)

		// Normally the user can press the skill button again if it doesn't go off
		// However, once the animation starts this is no longer possible, so instead we simulate retrying each skill
		if(!info.noRetry)
			retry(() => {
				if((SKILL_RETRY_ALWAYS && type != 'C_PRESS_SKILL') || currentAction && currentAction.skill == skill) return toServerLocked(data)
				return false
			})
	}

	function toServerLocked(...args) {
		sending = true
		let success = dispatch.toServer(...args)
		sending = false

		return success
	}

	dispatch.hook('C_CANCEL_SKILL', 1, event => {
		if(DEBUG) debug(['-> C_CANCEL_SKILL', skillId(event.skill), event.type].join(' '))

		if(currentAction) {
			let info = skillInfo(currentAction.skill) // event.skill can be wrong, so use the known current skill instead
			if(info && info.type == 'lockon') sendActionEnd(event.type)
		}
	})

	dispatch.hook('S_ACTION_STAGE', 3, event => {
		if(isMe(event.gameId)) {
			if(DEBUG) {
				let duration = Date.now() - debugActionTime,
					strs = [skillInfo(event.skill) ? '<X' : '<-', 'S_ACTION_STAGE', skillId(event.skill), event.stage, (Math.round(event.speed * 1000) / 1000) + 'x']

				if(DEBUG_LOC) strs.push(...[event.w + '\xb0', '(' + Math.round(event.x), Math.round(event.y), Math.round(event.z) + ')'])

				strs.push(...[event.unk, event.unk1, event.toX, event.toY, event.toZ, event.target.toNumber() ? 1 : 0])

				if(serverAction)
					strs.push(...[
						(Math.round(calcDistance(serverAction, event) * 1000) / 1000) + 'u',
						duration + 'ms',
						'(' + Math.round(duration * serverAction.speed) + 'ms)'
					])

				if(event.movement.length) {
					let movement = []

					for(let e of event.movement)
						movement.push(e.duration + ' ' + e.speed + ' ' + e.unk + ' ' + e.distance)

					strs.push('(' + movement.join(', ') + ')')
				}

				debug(strs.join(' '))
				debugActionTime = Date.now()
			}

			let info = skillInfo(event.skill)
			if(info) {
				if(currentAction && (event.skill == currentAction.skill || Math.floor((event.skill - 0x4000000) / 10000) == Math.floor((currentAction.skill - 0x4000000) / 10000)) && event.stage == currentAction.stage) {
					clearTimeout(serverTimeout)
					serverConfirmedAction = true
					dequeueNotifyLocation(event.skill)

					if(JITTER_COMPENSATION && event.stage == 0) {
						let delay = Date.now() - lastStartTime - ping.min

						if(delay > 0 && delay < 1000) {
							delayNext = delay

							if(stageEnd) {
								stageEndTime += delay
								refreshStageEnd()
							}
						}
					}
				}

				if(info.forceClip && event.movement.length) {
					let distance = 0
					for(let m of event.movement) distance += m.distance

					if(info.distance < 0) distance = -distance

					oopsLocation = applyDistance(lastStartLocation, distance)

					if(!currentAction || currentAction.skill != event.skill) sendInstantMove(oopsLocation)
				}

				// If the server sends 2 S_ACTION_STAGE in a row without a S_ACTION_END between them and the last one is an emulated skill,
				// this stops your character from being stuck in the first animation (although slight desync will occur)
				if(serverAction && serverAction == currentAction && !skillInfo(currentAction.skill)) sendActionEnd(6)

				serverAction = event
				return false
			}

			serverAction = event

			if(event.id == lastEndedId) return false

			if(currentAction && skillInfo(currentAction.skill)) sendActionEnd(lastEndSkill == currentAction.skill ? lastEndType || 6 : 6)

			currentAction = event
			updateLocation()
		}
	})

	dispatch.hook('S_GRANT_SKILL', 1, event => {
		if(DEBUG) debug(['<- S_GRANT_SKILL', skillId(event.skill)].join(' '))

		if(skillInfo(modifyChain(event.skill, 0))) return false
	})

	dispatch.hook('S_INSTANT_DASH', 1, event => {
		if(isMe(event.source)) {
			if(DEBUG) {
				let duration = Date.now() - debugActionTime,
					strs = [(serverAction && skillInfo(serverAction.skill)) ? '<X' : '<-', 'S_INSTANT_DASH', event.unk1, event.unk2, event.unk3]

				if(DEBUG_LOC) strs.push(...[event.w + '\xb0', '(' + Math.round(event.x), Math.round(event.y), Math.round(event.z) + ')'])

				strs.push(...[
					(Math.round(calcDistance(serverAction, event) * 1000) / 1000) + 'u',
					duration + 'ms',
					'(' + Math.round(duration * serverAction.speed) + 'ms)'
				])

				debug(strs.join(' '))
			}

			if(serverAction && skillInfo(serverAction.skill)) return false
		}
	})

	dispatch.hook('S_INSTANT_MOVE', 1, event => {
		if(isMe(event.id)) {
			if(DEBUG) {
				let info = serverAction && skillInfo(serverAction.skill),
					duration = Date.now() - debugActionTime,
					strs = ['<- S_INSTANT_MOVE']

				if(DEBUG_LOC) strs.push(...[event.w + '\xb0', '(' + Math.round(event.x), Math.round(event.y), Math.round(event.z) + ')'])

				strs.push(...[
					(Math.round(Math.sqrt(Math.pow(event.x - serverAction.x, 2) + Math.pow(event.y - serverAction.y, 2)) * 1000) / 1000) + 'u',
					duration + 'ms',
					'(' + Math.round(duration * serverAction.speed) + 'ms)'
				])

				debug(strs.join(' '))
			}

			currentLocation = {
				x: event.x,
				y: event.y,
				z: event.z,
				w: event.w,
				inAction: true
			}

			let info = serverAction && skillInfo(serverAction.skill)

			if(info && info.type == 'teleport' && currentAction && currentAction.skill != serverAction.skill)
				oopsLocation = currentLocation
		}
	})

	dispatch.hook('S_ACTION_END', 2, event => {
		if(isMe(event.gameId)) {
			if(DEBUG) {
				let duration = Date.now() - debugActionTime,
					strs = [(event.id == lastEndedId || skillInfo(event.skill)) ? '<X' : '<-', 'S_ACTION_END', skillId(event.skill), event.type]

				if(DEBUG_LOC) strs.push(...[event.w + '\xb0', '(' + Math.round(event.x), Math.round(event.y), Math.round(event.z) + ')'])

				if(serverAction)
					strs.push(...[
						(Math.round(Math.sqrt(Math.pow(event.x - serverAction.x, 2) + Math.pow(event.y - serverAction.y, 2)) * 1000) / 1000) + 'u',
						duration + 'ms',
						'(' + Math.round(duration * serverAction.speed) + 'ms)'
					])
				else strs.push('???')

				debug(strs.join(' '))
			}

			serverAction = null
			lastEndSkill = event.skill
			lastEndType = event.type

			if(event.id == lastEndedId) {
				lastEndedId = 0
				return false
			}

			let info = skillInfo(event.skill)
			if(info) {
				if(info.type == 'dash')
					// If the skill ends early then there should be no significant error
					if(currentAction && event.skill == currentAction.skill) {
						currentLocation = {
							x: event.x,
							y: event.y,
							z: event.z,
							w: event.w
						}
						sendActionEnd(event.type)
					}
					// Worst case scenario, teleport the player back if the error was large enough for the client to act on it
					else if(!lastEndLocation || Math.round(lastEndLocation.x / 100) != Math.round(event.x / 100) || Math.round(lastEndLocation.y / 100) != Math.round(event.y / 100) || Math.round(lastEndLocation.z / 100) != Math.round(event.z / 100))
						sendInstantMove({
							x: event.x,
							y: event.y,
							z: event.z,
							w: event.w
						})

				// Skills that may only be cancelled during part of the animation are hard to emulate, so we use server response instead
				// This may cause bugs with very high ping and casting the same skill multiple times
				if(currentAction && event.skill == currentAction.skill && [2, 25, 29, 43].includes(event.type))
					sendActionEnd(event.type)

				return false
			}

			if(!currentAction)
				console.log('[SkillPrediction] S_ACTION_END: currentAction is null', skillId(event.skill), event.id)
			else if(event.skill != currentAction.skill)
				console.log('[SkillPrediction] S_ACTION_END: skill mismatch', skillId(currentAction.skill), skillId(event.skill), currentAction.id, event.id)

			currentAction = null
		}
	})

	dispatch.hook('S_EACH_SKILL_RESULT', 4, event => {
		if(isMe(event.target) && event.setTargetAction) {
			if(DEBUG) {
				let duration = Date.now() - debugActionTime,
					strs = ['<- S_EACH_SKILL_RESULT.setTargetAction', skillId(event.targetAction), event.targetStage]

				if(DEBUG_LOC) strs.push(...[event.targetW + '\xb0', '(' + Math.round(event.targetX), Math.round(event.targetY), Math.round(event.targetZ) + ')'])

				debug(strs.join(' '))
			}

			if(currentAction && skillInfo(currentAction.skill)) sendActionEnd(9)

			currentAction = serverAction = {
				x: event.targetX,
				y: event.targetY,
				z: event.targetZ,
				w: event.targetW,
				skill: event.targetAction,
				stage: event.targetStage,
				id: event.targetId
			}

			updateLocation()
		}
	})

	dispatch.hook('S_DEFEND_SUCCESS', 1, event => {
		if(isMe(event.cid))
			if(currentAction && currentAction.skill == serverAction.skill) currentAction.defendSuccess = true
			else if(DEFEND_SUCCESS_STRICT || job != 10) return false
	})

	dispatch.hook('S_CANNOT_START_SKILL', 1, event => {
		if(DEBUG) debug('<- S_CANNOT_START_SKILL ' + skillId(event.skill, Flags.Player))

		if(skillInfo(event.skill, true)) {
			if(SKILL_DELAY_ON_FAIL && SKILL_RETRY_COUNT && currentAction && (!serverAction || currentAction.skill != serverAction.skill) && event.skill == currentAction.skill - 0x4000000)
				delayNext += SKILL_RETRY_MS

			return false
		}
	})

	dispatch.hook('C_CAN_LOCKON_TARGET', 1, event => {
		let info = skillInfo(event.skill)
		if(info) {
			let ok = true

			if(info.partyOnly) {
				ok = false

				if(partyMembers) 
					for(let member of partyMembers)
						if(member.equals(event.target)) {
							ok = true
							break
						}
			}

			dispatch.toClient('S_CAN_LOCKON_TARGET', Object.assign({ok}, event))
		}
	})

	dispatch.hook('S_CAN_LOCKON_TARGET', 1, event => skillInfo(event.skill) ? false : undefined)

	if(DEBUG_PROJECTILE) {
		dispatch.hook('S_SPAWN_PROJECTILE', 2, event => {
			if(!isMe(event.gameId)) return

			debug(`<- S_SPAWN_PROJECTILE ${skillId(event.skill)} ${event.unk1} ${event.x} ${event.y} ${event.z} ${event.toX} ${event.toY} ${event.toZ} ${event.moving} ${event.speed} ${event.unk2} ${event.unk3} ${event.w}`)

			if(skillInfo(event.skill)) {
				serverProjectiles[event.id.toString()] = event.skill
				return false
			}
		})

		dispatch.hook('S_DESPAWN_PROJECTILE', 2, event => {
			debug(`<- S_DESPAWN_PROJECTILE ${event.unk1} ${event.unk2}`)

			let idStr = event.id.toString()
			if(serverProjectiles[idStr]) {
				delete serverProjectiles[idStr]
				return false
			}
		})

		dispatch.hook('S_START_USER_PROJECTILE', 4, event => {
			if(!isMe(event.gameId)) return

			debug(`<- S_START_USER_PROJECTILE ${skillId(event.skill, Flags.Player)} ${event.x} ${event.y} ${event.z} ${event.toX} ${event.toY} ${event.toZ} ${event.speed} ${event.distance} ${event.curve}`)

			let info = skillInfo(event.skill, true)
			if(info) {
				serverProjectiles[event.id.toString()] = Flags.Player + event.skill
				applyProjectileHits(event.id, Flags.Player + event.skill)
				return false
			}
		})

		dispatch.hook('S_END_USER_PROJECTILE', 3, event => {
			debug(`<- S_END_USER_PROJECTILE ${event.unk1} ${event.unk2} ${event.target.toNumber() ? 1 : 0}`)

			let idStr = event.id.toString()
			if(serverProjectiles[idStr]) {
				delete serverProjectiles[idStr]
				return false
			}
		})

		dispatch.hook('C_HIT_USER_PROJECTILE', 2, event => {
			debug(`-> C_HIT_USER_PROJECTILE ${event.targets.length} ${event.end}`)

			let idStr = event.id.toString(),
				skill = clientProjectiles[idStr]

			if(skill) {
				if(event.end) removeProjectile(event.id, true, event.targets[0] || true)

				for(let id in serverProjectiles)
					if(serverProjectiles[id] === skill) {
						event.id = Long.fromString(id, true)
						return true
					}

				clientProjectileHits.push(Object.assign(event, {
					skill,
					time: Date.now()
				}))
				return false
			}
		})

		function applyProjectileHits(id, skill) {
			// Garbage collect expired hits
			for(let i = 0, expiry = Date.now() - getServerTimeout(); i < clientProjectileHits.length; i++)
				if(clientProjectileHits[i].time <= expiry)
					clientProjectileHits.splice(i--, 1)

			for(let i = 0; i < clientProjectileHits.length; i++) {
				let event = clientProjectileHits[i]

				if(event.skill === skill) {
					clientProjectileHits.splice(i--, 1)

					event.id = id
					dispatch.toServer('C_HIT_USER_PROJECTILE', 2, event)

					if(event.end) {
						delete serverProjectiles[id.toString()]
						return
					}
				}
			}
		}
	}

	function startAction(opts) {
		let info = opts.info

		if(info.consumeAbnormal)
			if(Array.isArray(info.consumeAbnormal))
				for(let id of info.consumeAbnormal)
					abnormality.remove(id)
			else
				abnormality.remove(info.consumeAbnormal)

		sendActionStage(opts)

		if(info.type === 'dash' || info.projectiles)
			effectsTimeouts.push(setTimeout(sendActionEffects, 25, opts)) // Emulate server tick delay

		if(info.triggerAbnormal)
			for(let id in info.triggerAbnormal) {
				let abnormal = info.triggerAbnormal[id]

				if(Array.isArray(abnormal))
					abnormality.add(id, abnormal[0], abnormal[1])
				else
					abnormality.add(id, abnormal, 1)
			}

		lastStartTime = Date.now()
	}

	function sendActionStage(opts) {
		clearTimeout(serverTimeout)

		opts.stage = opts.stage || 0
		opts.distanceMult = opts.distanceMult || 1

		let info = opts.info,
			multiStage = Array.isArray(info.length),
			movement = opts.movement

		movePlayer(opts.distance * opts.distanceMult)

		if(multiStage)
			movement = movement && movement[opts.stage] || !opts.moving && get(info, 'inPlace', 'movement', opts.stage) || get(info, 'movement', opts.stage) || []
		else
			movement = movement || !opts.moving && get(info, 'inPlace', 'movement') || info.movement || []

		dispatch.toClient('S_ACTION_STAGE', 3, currentAction = {
			gameId: myChar(),
			x: currentLocation.x,
			y: currentLocation.y,
			z: currentLocation.z,
			w: currentLocation.w,
			templateId,
			skill: opts.skill,
			stage: opts.stage,
			speed: info.type == 'charging' ? 1 : opts.speed,
			id: actionNumber,
			unk: 1,
			unk1: 0,
			toX: 0,
			toY: 0,
			toZ: 0,
			target: 0,
			movement
		})

		opts.distance = (multiStage ? get(info, 'distance', opts.stage) : info.distance) || 0
		stageEnd = null

		let speed = opts.speed + (info.type == 'charging' ? opts.chargeSpeed : 0),
			noTimeout = false

		if(serverAction && (serverAction.skill == currentAction.skill || Math.floor((serverAction.skill - 0x4000000) / 10000) == Math.floor((currentAction.skill - 0x4000000) / 10000)) && serverAction.stage == currentAction.stage)
			noTimeout = true

		switch(info.type) {
			case 'dynamicDistance':
				opts.distance = calcDistance(currentLocation, opts.targetLoc)
				break
			case 'teleport':
				if(opts.stage != info.teleportStage) break

				opts.distance = Math.min(opts.distance, Math.max(0, calcDistance(currentLocation, opts.targetLoc) - 15)) // Client is approx. 15 units off
				sendInstantMove(Object.assign(applyDistance(currentLocation, opts.distance), {z: opts.targetLoc.z, w: currentLocation.w}))
				opts.distance = 0
				break
			case 'charging':
				if(opts.stage == 0 || opts.stage < info.length.length) break

				if(info.autoRelease !== undefined) {
					stageEnd = () => {
						toServerLocked('C_PRESS_SKILL', 1, {
							skill: opts.skill,
							start: false,
							x: currentLocation.x,
							y: currentLocation.y,
							z: currentLocation.z,
							w: currentLocation.w
						})
						grantCharge(opts.skill, info, opts.stage)
					}

					if(info.autoRelease === 0) {
						stageEnd()
						stageEnd = null
					}
					else stageEndTimeout = setTimeout(stageEnd, Math.round(info.autoRelease / speed))
				}
			case 'holdInfinite':
				if(!noTimeout) serverTimeout = setTimeout(sendActionEnd, getServerTimeout(), 6)
				return
		}

		let length = Math.round((multiStage ? info.length[opts.stage] : info.length) / speed)

		if(!noTimeout) {
			let serverTimeoutTime = getServerTimeout()
			if(length > serverTimeoutTime) serverTimeout = setTimeout(sendActionEnd, serverTimeoutTime, 6)
		}

		if(multiStage) {
			if(!opts.moving) {
				let inPlaceDistance = get(info, 'inPlace', 'distance', opts.stage)

				if(inPlaceDistance !== undefined) opts.distance = inPlaceDistance
			}

			if(opts.stage + 1 < info.length.length) {
				opts.stage += 1
				stageEnd = sendActionStage.bind(null, opts)
				stageEndTime = Date.now() + length
				stageEndTimeout = setTimeout(stageEnd, length)
				return
			}
		}
		else
			if(!opts.moving) {
				let inPlaceDistance = get(info, 'inPlace', 'distance')

				if(inPlaceDistance !== undefined) opts.distance = inPlaceDistance
			}

		if(info.type == 'dash' && opts.distance) {
			let distance = calcDistance(lastStartLocation, opts.targetLoc)

			if(distance < opts.distance) {
				length *= distance / opts.distance
				opts.distance = distance
			}
		}

		if(info.type == 'charging') {
			opts.stage += 1
			stageEnd = sendActionStage.bind(null, opts)
			stageEndTime = Date.now() + length
			stageEndTimeout = setTimeout(stageEnd, length)
			return
		}

		stageEnd = sendActionEnd.bind(null, info.type == 'dash' ? 39 : 0, opts.distance * opts.distanceMult)
		stageEndTime = Date.now() + length
		stageEndTimeout = setTimeout(stageEnd, length)
	}

	function sendActionEffects(opts) {
		let info = opts.info

		if(info.type === 'dash') sendInstantDash(opts.targetLoc)

		if(DEBUG_PROJECTILE && info.projectiles)
			for(let chain of info.projectiles) {
				castProjectile({
					skill: modifyChain(opts.skill, chain),
					targetLoc: opts.targetLoc
				})
			}
	}

	function clearEffects() {
		if(!effectsTimeouts.length) return
		for(let t of effectsTimeouts) clearTimeout(t)
		effectsTimeouts = []
	}

	function clearStage() {
		clearTimeout(serverTimeout)
		clearEffects()
		clearTimeout(stageEndTimeout)
	}

	function refreshStageEnd() {
		clearTimeout(stageEndTimeout)
		stageEndTimeout = setTimeout(stageEnd, stageEndTime - Date.now())
	}

	function grantCharge(skill, info, stage) {
		let levels = info.chargeLevels
		dispatch.toClient('S_GRANT_SKILL', 1, {skill: modifyChain(skill, levels ? levels[stage] : 10 + stage)})
	}

	function castProjectile(opts) {
		let info = skillInfo(opts.skill)

		if(info.delay) effectsTimeouts.push(setTimeout(addProjectile, info.delay, opts))
		else addProjectile(opts)
	}

	function addProjectile(opts) {
		let skill = opts.skill,
			info = skillInfo(skill)

		if(!info) return

		let id = new Long(0xffffffff, clientProjectileId = clientProjectileId + 1 >>> 0, true)

		clientProjectiles[id.toString()] = skill

		setTimeout(removeProjectile, 5000, id, info.type === 'userProjectile', true)

		if(info.type === 'userProjectile') {
			let loc = applyDistance(Object.assign({}, currentLocation), 15)

			dispatch.toClient('S_START_USER_PROJECTILE', 4, {
				gameId,
				templateId,
				id,
				skill,
				x: loc.x,
				y: loc.y,
				z: loc.z + 30,
				toX: opts.targetLoc.x,
				toY: opts.targetLoc.y,
				toZ: opts.targetLoc.z,
				speed: info.flyingSpeed,
				distance: info.flyingDistance,
				curve: !!info.flyingDistance
			})
		}
	}

	function removeProjectile(id, user, explode) {
		delete clientProjectiles[id.toString()]

		if(user) {
			let target = typeof explode === 'object' ? explode : 0

			explode = !!explode

			dispatch.toClient('S_END_USER_PROJECTILE', 3, {
				id: id,
				unk1: explode && !target,
				unk2: explode,
				target
			})
		}
	}

	function sendInstantDash(location) {
		dispatch.toClient('S_INSTANT_DASH', 1, {
			source: myChar(),
			unk1: 0,
			unk2: 0,
			unk3: 0,
			x: location.x,
			y: location.y,
			z: location.z,
			w: currentLocation.w
		})
	}

	function sendInstantMove(location) {
		if(location) currentLocation = location

		dispatch.toClient('S_INSTANT_MOVE', 1, {
			id: myChar(),
			x: currentLocation.x,
			y: currentLocation.y,
			z: currentLocation.z,
			w: currentLocation.w
		})
	}

	function sendActionEnd(type, distance) {
		clearStage()

		if(!currentAction) return

		if(DEBUG) debug(['<* S_ACTION_END', skillId(currentAction.skill), type || 0, currentLocation.w + '\xb0', (distance || 0) + 'u'].join(' '))

		if(oopsLocation && (FORCE_CLIP_STRICT || !currentLocation.inAction)) sendInstantMove(oopsLocation)
		else movePlayer(distance)

		dispatch.toClient('S_ACTION_END', 2, {
			gameId: myChar(),
			x: currentLocation.x,
			y: currentLocation.y,
			z: currentLocation.z,
			w: currentLocation.w,
			templateId,
			skill: currentAction.skill,
			type: type || 0,
			id: currentAction.id
		})

		if(currentAction.id == actionNumber) {
			let info = skillInfo(currentAction.skill)
			if(info) {
				if(info.consumeAbnormalEnd)
					if(Array.isArray(info.consumeAbnormalEnd))
						for(let id of info.consumeAbnormalEnd)
							abnormality.remove(id)
					else
						abnormality.remove(info.consumeAbnormalEnd)

				if(info.type == 'dash') lastEndLocation = currentLocation
			}
		}
		else lastEndedId = currentAction.id

		actionNumber++
		if(actionNumber > 0xffffffff) actionNumber = 0x80000000

		oopsLocation = currentAction = null
	}

	function sendCannotStartSkill(skill) {
		dispatch.toClient('S_CANNOT_START_SKILL', 1, {skill})
	}

	function sendSystemMessage(type, vars) {
		let message = '@' + sysmsg.maps.get(dispatch.base.protocolVersion).name.get(type)

		for(let key in vars) message += '\v' + key + '\v' + vars[key]

		dispatch.toClient('S_SYSTEM_MESSAGE', 1, { message })
	}

	function updateLocation(event, inAction, special) {
		event = event || currentAction

		currentLocation = special ? {
			x: event.x,
			y: event.y,
			z: event.z,
			w: event.w || currentLocation.w, // Should be a skill flag maybe?
			inAction
		} : {
			x: event.x,
			y: event.y,
			z: event.z,
			w: event.w,
			inAction
		}
	}

	function retry(cb, count = 1) {
		if(count > SKILL_RETRY_COUNT) return

		setTimeout(() => {
			if(cb()) retry(cb, count + 1)
		}, SKILL_RETRY_MS)
	}

	function movePlayer(distance) {
		if(distance && !currentLocation.inAction) applyDistance(currentLocation, distance)
	}

	function calcDistance(loc1, loc2) {
		return Math.sqrt(Math.pow(loc2.x - loc1.x, 2) + Math.pow(loc2.y - loc1.y, 2))
	}

	function applyDistance(loc, distance) {
		let r = (loc.w / 0x8000) * Math.PI

		loc.x += Math.cos(r) * distance
		loc.y += Math.sin(r) * distance
		return loc
	}

	// Modifies the chain part (last 2 digits) of a skill ID, preserving flags
	function modifyChain(id, chain) {
		return id - ((id & 0x3ffffff) % 100) + chain
	}

	function skillId(id, flagAs) {
		id |= flagAs

		let skillFlags = ['P', 'C', '[?3]', '[?4]', '[?5]', '[?6]'],
			flags = ''

		for(let i = 0, x = id >>> 26; x; i++, x >>>= 1)
			if(x & 1) flags += skillFlags[i]

		id = (id & 0x3ffffff).toString()

		switch(flags) {
			case 'P':
				id = [id.slice(0, -4), id.slice(-4, -2), id.slice(-2)].join('-')
				break
			case 'C':
				id = [id.slice(0, -2), id.slice(-2)].join('-')
				break
		}

		return flags + id
	}

	function skillInfo(id, local) {
		if(!local) id -= 0x4000000

		let cached = skillsCache[id]

		if(cached !== undefined) return cached

		let group = Math.floor(id / 10000),
			level = (Math.floor(id / 100) % 100) - 1,
			sub = id % 100,
			info = [ // Ordered by least specific < most specific
				get(skills, job, '*'),
				get(skills, job, '*', 'level', level),
				get(skills, job, '*', 'race', race),
				get(skills, job, '*', 'race', race, 'level', level),
				get(skills, job, group, '*'),
				get(skills, job, group, '*', 'level', level),
				get(skills, job, group, '*', 'race', race),
				get(skills, job, group, '*', 'race', race, 'level', level),
				get(skills, job, group, sub),
				get(skills, job, group, sub, 'level', level),
				get(skills, job, group, sub, 'race', race),
				get(skills, job, group, sub, 'race', race, 'level', level)
			]

		// Note: Exact skill (group, sub) must be specified for prediction to be enabled. This helps to avoid breakage in future patches
		if(info[8]) {
			cached = skillsCache[id] = Object.assign({}, ...info)
			// Sanitize to reduce memory usage
			delete cached.race
			delete cached.level
			return cached
		}

		return skillsCache[id] = null
	}

	function isMe(id) {
		return gameId.equals(id) || vehicleEx && vehicleEx.equals(id)
	}

	function myChar() {
		return vehicleEx ? vehicleEx : gameId
	}

	function getServerTimeout() {
		return ping.max + (SKILL_RETRY_COUNT * SKILL_RETRY_MS) + SERVER_TIMEOUT
	}

	function get(obj, ...keys) {
		if(obj === undefined) return

		for(let key of keys)
			if((obj = obj[key]) === undefined)
				return

		return obj
	}

	function debug(msg) {
		console.log('[%d] %s', ('0000' + (Date.now() % 10000)).substr(-4,4), msg)
	}
}