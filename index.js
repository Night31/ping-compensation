//----------
// TODO
//----------
module.exports = function PingCompensation(dispatch) {
    
    //----------
    // Constants
    //----------
    const settings = require('./config/settings.js')
    const skills = require('./config/skills.js')
    
    // Skill Prediction compatability
    const Ping = (!settings.skillPredictionCompatible) ? require('./config/ping.js') : false
    
    // 1000/FPS (default: 20 ms or 1000/(50 FPS))
    const frameTime = settings.frameTime
    
    // for bug-fixing
    const debug = false
    
    //----------
    // Variables
    //----------
    let gameId = null,
        templateId= null,
        job = -1,
        race = -1,
        timeouts = {},
        ping = {},
        startTime = Date.now(),
        alive = false,
        mounted = false,
        queuedPacket = false,
        queuedTimeout = false,
        currentAction = false
        
    // Skill Prediction compatability
    if (settings.skillPredictionCompatible) {
        ping.list = []
    }
    else {
        ping = Ping(dispatch)
    }
    
    //----------
    // Functions
    //----------
    
    // getValue
    function getValue(name, skillBase, skillSub) {
        let value = 0
        // check universal skillSub
        if (skills[job][skillBase]["*"]) {
            if (skills[job][skillBase]["*"][name]) {
                value = skills[job][skillBase]["*"][name]
            }
            // check universal racial value
            if (skills[job][skillBase]["*"][race] && skills[job][skillBase]["*"][race][name]) {
                value = skills[job][skillBase]["*"][race][name]
            }
        }
        // check subSkill value
        if (skills[job][skillBase][skillSub][name]) {
            value = skills[job][skillBase][skillSub][name]
        }
        // check subSkill racial value
        if (skills[job][skillBase][skillSub][race] && skills[job][skillBase][skillSub][race][name]) {
            value = skills[job][skillBase][skillSub][race][name]
        }
        return value
    }
    
    // endSkill
    function endSkill(event) {
        if (debug) {console.log(`S_ACTION_END FAKE ${Date.now() - startTime} ${JSON.stringify(Object.values(event))}`)}
        if (event) {
            dispatch.toClient('S_ACTION_END', 2, event)
            timeouts[event.id] = false
        }
    }
    
    //----------
    // Hooks
    //----------
    
    // C_REQUEST_GAMESTAT_PING FAKE
    dispatch.hook('C_REQUEST_GAMESTAT_PING', 1, {order: 10, filter: {fake: true}},() => {
        if (settings.skillPredictionCompatible && !ping.request) {ping.request = Date.now()}
     })
    
    // S_RESPONSE_GAMESTAT_PONG
     dispatch.hook('S_RESPONSE_GAMESTAT_PONG', 1, {order: 10, filter: {fake: false, silenced: null}},() => {
         if (settings.skillPredictionCompatible && ping.request) {
             ping.list.push(Date.now() - ping.request)
             ping.request = false
             if (ping.list.length > 20) {
                 ping.list.splice(0,1)
             }
             ping.min = Math.min(...ping.list)
            return false
         }
     })
    
    // S_LOGIN
    dispatch.hook('S_LOGIN', 9, event => {
        gameId = event.gameId
        templateId = event.templateId
        job = (templateId - 10101) % 100
        race = Math.floor((templateId - 10101) / 100)
    })
    
    // C_PRESS_SKILL
    dispatch.hook('C_PRESS_SKILL', 1, {order: 10, filter: {fake: null}}, event => {
        // update S_ACTION_END
        for (let coord of ["x", "y", "z", "w"]) {
            if (currentAction && timeouts[currentAction.id]) {
                currentAction[coord] = event[coord]
            }
        }
    })
    
    // C_PLAYER_LOCATION
    dispatch.hook('C_PLAYER_LOCATION', 2, {order: -10, filter: {fake: false}}, event => {
        // update S_ACTION_END
        for (let coord of ["x", "y", "z", "w"]) {
            if (currentAction && timeouts[currentAction.id]) {
                currentAction[coord] = event[coord]
            }
        }
    })
    
    // C_PLAYER_LOCATION
    dispatch.hook('C_PLAYER_LOCATION', 'raw', {order: -5}, (code, data, fromServer, fake) => {
        if (!fake) {
            // if between fake and real S_ACTION_END
            if (currentAction && !timeouts[currentAction.id]) {
                queuedPacket = data
                queuedTimeout = setTimeout(()=>{
                    queuedPacket = false
                    currentAction = false
                },1000)
                // block location packets
                return false
            }
        }
    })
    
    // C_NOTIFY_LOCATION_IN_ACTION
    dispatch.hook('C_NOTIFY_LOCATION_IN_ACTION', 1, {order: -10, filter: {fake: null}}, event => {
        // update S_ACTION_END
        for (let coord of ["x", "y", "z", "w"]) {
            if (currentAction && timeouts[currentAction.id]) {
                currentAction[coord] = event[coord]
            }
        }
    })
    
    // C_NOTIFY_LOCATION_IN_DASH
    dispatch.hook('C_NOTIFY_LOCATION_IN_DASH', 1, {order: -10, filter: {fake: null}}, event => {
        // update S_ACTION_END
        for (let coord of ["x", "y", "z", "w"]) {
            if (currentAction && timeouts[currentAction.id]) {
                currentAction[coord] = event[coord]
            }
        }
    })
    
    // S_INSTANT_DASH
    dispatch.hook('S_INSTANT_DASH', 2, {order: 10, filter: {fake: null}}, event => {
        if (event.source.equals(gameId)){
            // update S_ACTION_END
            for (let coord of ["x", "y", "z", "w"]) {
                if (currentAction && timeouts[currentAction.id]) {
                    currentAction[coord] = event[coord]
                }
            }
        }
    })
    
    // S_INSTANT_MOVE
    dispatch.hook('S_INSTANT_MOVE', 1, {order: 10, filter: {fake: null}}, event => {
        if (event.id.equals(gameId)){
            // update S_ACTION_END
            for (let coord of ["x", "y", "z", "w"]) {
                if (currentAction && timeouts[currentAction.id]) {
                    currentAction[coord] = event[coord]
                }
            }
        }
    })
    
    // S_ACTION_STAGE
    dispatch.hook('S_ACTION_STAGE', 2, {order: 10, filter: {fake: false}}, event => {
        // if character is your character
        if (event.gameId.equals(gameId)) {
            if (debug) {console.log(`S_ACTION_STAGE ${Date.now() - startTime} ${JSON.stringify(Object.values(event))}`)}
            // get skill id
            let skill = event.skill - 0x4000000,
                skillBase = Math.floor(skill / 10000),
                skillSub = skill % 100
            // if skill is in config
            if (alive && !mounted && skills[job] && settings[job] && skills[job][skillBase] && settings[job][skillBase] && skills[job][skillBase][skillSub]) {
                // get length
                let length = getValue("length", skillBase, skillSub)
                // if skill is multi-stage
                let lengthArray = false
                if (Array.isArray(length)) {
                    lengthArray = length
                    if (event.stage < lengthArray.length) {length = lengthArray[event.stage]}
                }
                //if (debug) console.log('length', length)
                if (length && length > 0) {
                    // change animation speed
                    // cap ping compensation at 1 frame
                    if (ping.min > length - frameTime * event.speed) {
                        event.speed = event.speed * length / (length - frameTime * event.speed)
                    }
                    else {
                        event.speed = event.speed * length / (length - ping.min)
                    }
                    if (debug) {console.log(`Increased Speed ${event.speed}`)}
                    // get distance
                    let distance = 0
                    // if server sends distance
                    if (event.movement[0]) {
                        // get total distance
                        for (let stage of event.movement) {
                            distance += stage.distance
                        }
                    }
                    // otherwise check config
                    else {
                        distance = getValue("distance", skillBase, skillSub)
                        // if skill is multi-stage
                        if (Array.isArray(distance)) {
                            distance = distance[event.stage]
                        }
                    }
                    //if (debug) console.log('distance', distance)
                    // get coordinates
                    let x,y
                    if (distance && Math.abs(distance) > 0) {
                        let r = (event.w / 0x8000) * Math.PI
                        x = event.x + Math.cos(r) * distance
                        y = event.y + Math.sin(r) * distance
                    }
                    // if skill type charging or lockon
                    let skillType = getValue("type", skillBase, skillSub)
                    if (['charging','lockon'].includes(skillType)) {
                        return true
                    }
                    // if multi-stage and not last stage
                    if (lengthArray && event.stage < lengthArray.length - 1) {
                        return true
                    }
                    // get end type ???
                        // TO DO
                    // send sActionEnd early
                    currentAction = {
                        gameId: event.gameId,
                        x: (x ? x : event.x),
                        y: (y ? y : event.y),
                        z: event.z,
                        w: event.w,
                        templateId: event.templateId,
                        skill: event.skill,
                        type: 0,
                        id: event.id
                    }
                    timeouts[event.id] = setTimeout(endSkill, length / event.speed, currentAction)
                    return true
                }
            }
        }
    })
    
    // S_ACTION_END
    dispatch.hook('S_ACTION_END', 2, {order: 10, filter: {fake: false}}, event => {
        // if character is your character
        if (event.gameId.equals(gameId)) {
            if (debug) {console.log(`S_ACTION_END ${Date.now() - startTime} ${JSON.stringify(Object.values(event))}`)}
            // if modded skill
            if (alive && !mounted && currentAction && currentAction.id == event.id) {
                clearTimeout(queuedTimeout)
                queuedTimeout = false
                // if not fake ended
                if (timeouts[event.id]) {
                    // disable fake endSkill
                    clearTimeout(timeouts[event.id])
                    timeouts[event.id] = false
                }
                // if fake ended
                else {
                    // if location emulated wrong
                    if (((currentAction.x - event.x)**2 + (currentAction.y - event.y)**2)**0.5 > 100 || Math.abs(currentAction.z - event.z) > 50) {
                        // teleport to correct location
                        if (debug) {console.log('S_INSTANT_MOVE correction')}
                        dispatch.toClient('S_INSTANT_MOVE', 1, {
                            id: gameId,
                            x: event.x,
                            y: event.y,
                            z: event.z,
                            w: event.w
                        })
                    }
                    else if (queuedPacket) {
                        dispatch.toServer(queuedPacket)
                    }
                    queuedPacket = false
                    currentAction = false
                    // hide this sActionEnd
                    return false
                }
            }
            queuedPacket = false
            currentAction = false
        }
    })
    
    // S_SPAWN_ME
    dispatch.hook('S_SPAWN_ME', 1, event => {
        alive = event.alive
    })

    // S_CREATURE_LIFE
    dispatch.hook('S_CREATURE_LIFE', 1, event => {
        if (gameId.equals(event.target)) {
            alive = event.alive
            if (!alive) {
                clearTimeout(timeouts[currentAction.id])
                timeouts[currentAction.id] = false
                queuedPacket = false
                currentAction = false
            }
        }
    })
    
    // S_LOAD_TOPO
    dispatch.hook('S_LOAD_TOPO', 1, event => {
        if (currentAction) {
            clearTimeout(timeouts[currentAction.id])
            timeouts[currentAction.id] = false
            queuedPacket = false
            currentAction = false
        }
        mounted = false
    })
    
    // S_MOUNT_VEHICLE
    dispatch.hook('S_MOUNT_VEHICLE', 1, event => {
        if (gameId.equals(event.target)) {
            mounted = true
        }
    })

    // S_UNMOUNT_VEHICLE
    dispatch.hook('S_UNMOUNT_VEHICLE', 1, event => {
        if (gameId.equals(event.target)) {
            mounted = false
        }
    })
    
    // S_MOUNT_VEHICLE_EX
    dispatch.hook('S_MOUNT_VEHICLE_EX', 1, event => {
        if (gameId.equals(event.target)) {
            mounted = true
        }
    })

    // S_UNMOUNT_VEHICLE_EX
    dispatch.hook('S_UNMOUNT_VEHICLE_EX', 1, event => {
        if (gameId.equals(event.target)) {
            mounted = false
        }
    })
}
