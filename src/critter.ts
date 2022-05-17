/*
Copyright 2014 darkf, Stratege
Copyright 2015 darkf

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { SkillSet, StatSet } from './char.js'
import { ActionPoints, AI } from './combat.js'
import { heart } from './heart.js'
import { directionOfDelta, hexDistance, hexToScreen, Point } from './geometry.js'
import globalState from './globalState.js'
import { lazyLoadImage } from './images.js'
import { Obj, objectIsWeapon, SerializedObj, WeaponObj } from './object.js'
import { Scripting } from './scripting.js'
import { getMessage } from './util.js'
import { Config } from './config.js'

// Collection of functions for dealing with critters

const animInfo: { [anim: string]: { type: string } } = {
    idle: { type: 'static' },
    attack: { type: 'static' },
    'weapon-reload': { type: 'static' },
    walk: { type: 'move' },
    'static-idle': { type: 'static' },
    static: { type: 'static' },
    use: { type: 'static' },
    pickUp: { type: 'static' },
    climb: { type: 'static' },
    hitFront: { type: 'static' },
    death: { type: 'static' },
    'death-explode': { type: 'static' },
    run: { type: 'move' },
}

const weaponSkins: { [weapon: string]: string } = {
    uzi: 'i',
    rifle: 'j',
}

const weaponAnims: { [weapon: string]: { [anim: string]: string } } = {
    punch: { idle: 'aa', attack: 'aq' },
}

// TODO: (Double-sided) enum
const attackMode: { [mode: string]: string | number } = {
    none: 0,
    punch: 1,
    kick: 2,
    swing: 3,
    thrust: 4,
    throw: 5,
    'fire single': 6,
    'fire burst': 7,
    flame: 8,

    0: 'none',
    1: 'punch',
    2: 'kick',
    3: 'swing',
    4: 'thrust',
    5: 'throw',
    6: 'fire single',
    7: 'fire burst',
    8: 'flame',
}

// TODO: (Double-sided) enum
const damageType: { [type: string]: string | number } = {
    Normal: 0,
    Laser: 1,
    Fire: 2,
    Plasma: 3,
    Electrical: 4,
    EMP: 5,
    Explosive: 6,

    0: 'Normal',
    1: 'Laser',
    2: 'Fire',
    3: 'Plasma',
    4: 'Electrical',
    5: 'EMP',
    6: 'Explosive',
}

// TODO: Figure out if we can derive the correct info from the game somehow
const weaponSkillMap: { [weapon: string]: string } = {
    uzi: 'Small Guns',
    rifle: 'Small Guns',
    spear: 'Melee Weapons',
    knife: 'Melee Weapons',
    club: 'Melee Weapons',
    sledge: 'Melee Weapons',
    flamethr: 'Big Guns',
    pistol: 'Small Guns',
}

interface AttackInfo {
    mode: number
    APCost: number
    maxRange: number
}

function parseAttack(weapon: WeaponObj): { first: AttackInfo; second: AttackInfo } {
    var attackModes = weapon.pro.extra['attackMode']
    var modeOne = attackMode[attackModes & 0xf] as number
    var modeTwo = attackMode[(attackModes >> 4) & 0xf] as number
    var attackOne: AttackInfo = { mode: modeOne, APCost: 0, maxRange: 0 }
    var attackTwo: AttackInfo = { mode: modeTwo, APCost: 0, maxRange: 0 }

    if (modeOne !== attackMode.none) {
        attackOne.APCost = weapon.pro.extra.APCost1
        attackOne.maxRange = weapon.pro.extra.maxRange1
    }

    if (modeTwo !== attackMode.none) {
        attackTwo.APCost = weapon.pro.extra.APCost2
        attackTwo.maxRange = weapon.pro.extra.maxRange2
    }

    return { first: attackOne, second: attackTwo }
}

// TODO: improve handling of melee
export class Weapon {
    weapon: any // TODO: any (because of melee)
    name: string
    modes: string[]
    mode: string // current mode
    type: string
    minDmg: number
    maxDmg: number
    weaponSkillType: string

    attackOne!: { mode: number; APCost: number; maxRange: number }
    attackTwo!: { mode: number; APCost: number; maxRange: number }

    constructor(weapon: WeaponObj) {
        this.weapon = weapon
        this.modes = ['single', 'called']

        if (weapon === null) {
            // default punch
            // todo: use character stats...
            // todo: fully turn this into a real weapon
            this.type = 'melee'
            this.minDmg = 1
            this.maxDmg = 2
            this.name = 'punch'
            this.weaponSkillType = 'Unarmed'
            this.weapon = {}
            this.weapon.pro = { extra: {} }
            this.weapon.pro.extra.maxRange1 = 1
            this.weapon.pro.extra.maxRange2 = 1
            this.weapon.pro.extra.APCost1 = 4
            this.weapon.pro.extra.APCost2 = 4
        } else {
            // todo: spears, etc
            this.type = 'gun'
            this.minDmg = weapon.pro.extra.minDmg
            this.maxDmg = weapon.pro.extra.maxDmg
            var s = weapon.art.split('/')
            this.name = s[s.length - 1]

            var attacks = parseAttack(weapon)
            this.attackOne = attacks.first
            this.attackTwo = attacks.second

            this.weaponSkillType = weaponSkillMap[this.name]
            if (this.weaponSkillType === undefined) console.log('unknown weapon type for ' + this.name)
        }

        this.mode = this.modes[0]
    }

    cycleMode(): void {
        this.mode = this.modes[(this.modes.indexOf(this.mode) + 1) % this.modes.length]
    }

    isCalled(): boolean {
        return this.mode === 'called'
    }

    getProjectilePID(): number {
        if (this.type === 'melee') return -1
        return this.weapon.pro.extra.projPID
    }

    // TODO: enum
    getMaximumRange(attackType: number): number {
        if (attackType === 1) return this.weapon.pro.extra.maxRange1
        if (attackType === 2) return this.weapon.pro.extra.maxRange2
        else throw 'invalid attack type ' + attackType
    }

    getAPCost(attackMode: number): number {
        return this.weapon.pro.extra['APCost' + attackMode]
    }

    getSkin(): string | null {
        if (this.weapon.pro === undefined || this.weapon.pro.extra === undefined) return null
        const animCodeMap: { [animCode: number]: string } = {
            0: 'a', // None
            1: 'd', // Knife
            2: 'e', // Club
            3: 'f', // Sledgehammer
            4: 'g', // Spear
            5: 'h', // Pistol
            6: 'i', // SMG
            7: 'j', // Rifle
            8: 'k', // Big Gun
            9: 'l', // Minigun
            10: 'm',
        } // Rocket Launcher
        return animCodeMap[this.weapon.pro.extra.animCode]
    }

    getAttackSkin(): string | null {
        if (this.weapon.pro === undefined || this.weapon.pro.extra === undefined) return null
        if (this.weapon === 'punch') return 'q'

        const modeSkinMap: { [mode: string]: string } = {
            punch: 'q',
            kick: 'r',
            swing: 'g',
            thrust: 'f',
            throw: 's',
            'fire single': 'j',
            'fire burst': 'k',
            flame: 'l',
        }

        // TODO: mode equipped
        if (this.attackOne.mode !== attackMode.none) {
            return modeSkinMap[this.attackOne.mode]
        }

        throw 'TODO'
    }

    getAnim(anim: string): string | null {
        if (weaponAnims[this.name] && weaponAnims[this.name][anim]) return weaponAnims[this.name][anim]

        var wep = this.getSkin() || 'a'
        switch (anim) {
            case 'idle':
                return wep + 'a'
            case 'walk':
                return wep + 'b'
            case 'attack':
                var attackSkin = this.getAttackSkin()
                return wep + attackSkin
            default:
                return null // let something else handle it
        }
    }

    canEquip(obj: Critter): boolean {
        return globalState.imageInfo[obj.getBase() + this.getAnim('attack')] !== undefined
    }

    getDamageType(): string {
        // Return the (string) damage type of the weapon, e.g. "Normal", "Laser", ...
        // Defaults to "Normal" if the weapon's PRO does not provide one.
        const rawDmgType = this.weapon.pro.extra.dmgType
        return rawDmgType !== undefined ? (damageType[rawDmgType] as string) : 'Normal'
    }
}

function getAnimDistance(art: string): number {
    var info = globalState.imageInfo[art]
    if (info === undefined) throw 'no image info for ' + art

    var firstShift = info.frameOffsets[0][0].ox
    var lastShift = info.frameOffsets[1][info.numFrames - 1].ox

    // distance = (shift x of last frame) - (shift x of first frame(?) + 16) / 32
    return Math.floor((lastShift - firstShift + 16) / 32)
}

interface PartialAction {
    startFrame: number
    endFrame: number
    step: number
}

function getAnimPartialActions(art: string, anim: string): { movement: number; actions: PartialAction[] } {
    const partialActions = { movement: 0, actions: [] as PartialAction[] }
    let numPartials = 1

    if (anim === 'walk' || anim === 'run') {
        numPartials = getAnimDistance(art)
        partialActions.movement = numPartials
    }

    if (numPartials === 0) numPartials = 1

    var delta = Math.floor(globalState.imageInfo[art].numFrames / numPartials)
    var startFrame = 0
    var endFrame = delta
    for (var i = 0; i < numPartials; i++) {
        partialActions.actions.push({ startFrame: startFrame, endFrame: endFrame, step: i })
        startFrame += delta
        endFrame += delta // ?
    }

    // extend last partial action to the last frame
    partialActions.actions[partialActions.actions.length - 1].endFrame = globalState.imageInfo[art].numFrames

    //console.log("partials: %o", partialActions)
    return partialActions
}

function hitSpatialTrigger(position: Point): any {
    // TODO: return type (SpatialTrigger)
    return globalState.gMap.getSpatials().filter((spatial) => hexDistance(position, spatial.position) <= spatial.range)
}

export function critterKill(
    obj: Critter,
    source?: Critter,
    useScript?: boolean,
    animName?: string,
    callback?: () => void
) {
    obj.dead = true
    obj.outline = null

    if (useScript === undefined || useScript === true) {
        Scripting.destroy(obj, source)
    }

    if (!animName || !obj.hasAnimation(animName)) animName = 'death'

    obj.staticAnimation(
        animName,
        function () {
            // todo: corpse-ify
            obj.frame-- // go to last frame
            obj.anim = undefined
            if (callback) callback()
        },
        true
    )
}

export function critterDamage(
    obj: Critter,
    damage: number,
    source: Critter,
    useScript: boolean = true,
    useAnim: boolean = true,
    damageType?: string,
    callback?: () => void
) {
    obj.stats.modifyBase('HP', -damage)
    if (obj.getStat('HP') <= 0) return critterKill(obj, source, useScript)

    if (useScript) {
        // TODO: Call damage_p_proc
    }

    // TODO: other hit animations
    if (useAnim && obj.hasAnimation('hitFront')) {
        obj.staticAnimation('hitFront', () => {
            obj.clearAnim()
            if (callback) callback()
        })
    }
}

function critterGetRawStat(obj: Critter, stat: string) {
    return obj.stats.getBase(stat)
}

function critterSetRawStat(obj: Critter, stat: string, amount: number) {
    // obj.stats[stat] = amount
    console.warn(`TODO: Change stat ${stat} to ${amount}`)
}

function critterGetRawSkill(obj: Critter, skill: string) {
    return obj.skills.getBase(skill)
}

function critterSetRawSkill(obj: Critter, skill: string, amount: number) {
    // obj.skills[skill] = amount
    console.warn(`TODO: Change skill ${skill} to ${amount}`)
}

interface SerializedCritter extends SerializedObj {
    stats: any
    skills: any

    // TODO: Properly (de)serialize WeaponObj
    // leftHand: SerializedObj;
    // rightHand: SerializedObj;

    aiNum: number
    teamNum: number
    // ai: AI; // TODO
    hostile: boolean

    isPlayer: boolean
    dead: boolean
}

const SERIALIZED_CRITTER_PROPS = ['stats', 'skills', 'aiNum', 'teamNum', 'hostile', 'isPlayer', 'dead']

export class Critter extends Obj {
    stats!: StatSet
    skills!: SkillSet

    leftHand?: WeaponObj // Left-hand object slot
    rightHand?: WeaponObj // Right-hand object slot

    type = 'critter'
    anim = 'idle'
    path: any = null // Holds pathfinding objects
    AP: ActionPoints | null = null

    aiNum: number = -1 // AI packet number
    teamNum: number = -1 // AI team number (TODO: implement this)
    ai: AI | null = null // AI packet
    hostile: boolean = false // Currently engaging an enemy?

    isPlayer: boolean = false // Is this critter the player character?
    dead: boolean = false // Is this critter dead?

    static fromPID(pid: number, sid?: number): Critter {
        return Obj.fromPID_(new Critter(), pid, sid)
    }

    static fromMapObject(mobj: any, deserializing: boolean = false): Critter {
        const obj = Obj.fromMapObject_(new Critter(), mobj, deserializing)

        if (deserializing) {
            // deserialize critter: copy fields from SerializedCritter
            console.log('Deserializing critter')
            // console.trace();

            for (const prop of SERIALIZED_CRITTER_PROPS) {
                // console.log(`loading prop ${prop} from SerializedCritter = ${mobj[prop]}`);
                ;(<any>obj)[prop] = mobj[prop]
            }

            if (mobj.stats) {
                obj.stats = new StatSet(mobj.stats.baseStats, mobj.stats.useBonuses)
                console.warn('Deserializing stat set: %o to: %o', mobj.stats, obj.stats)
            }
            if (mobj.skills) {
                obj.skills = new SkillSet(mobj.skills.baseSkills, mobj.skills.tagged, mobj.skills.skillPoints)
                console.warn('Deserializing skill set: %o to: %o', mobj.skills, obj.skills)
            }
        }

        return obj
    }

    init() {
        super.init()

        this.stats = StatSet.fromPro(this.pro)
        this.skills = SkillSet.fromPro(this.pro.extra.skills)
        // console.log("Loaded stats/skills from PRO: HP=%d Speech=%d", this.stats.get("HP"), this.skills.get("Speech", this.stats))
        this.name = getMessage('pro_crit', this.pro.textID) || ''

        // initialize AI packet / team number
        this.aiNum = this.pro.extra.AI
        this.teamNum = this.pro.extra.team

        // initialize weapons
        this.inventory.forEach((inv) => {
            if (inv.subtype === 'weapon') {
                var w = <WeaponObj>inv
                if (this.leftHand === undefined) {
                    if (w.weapon!.canEquip(this)) this.leftHand = w
                } else if (this.rightHand === undefined) {
                    if (w.weapon!.canEquip(this)) this.rightHand = w
                }
                //console.log("left: " + this.leftHand + " | right: " + this.rightHand)
            }
        })

        // default to punches
        if (!this.leftHand) this.leftHand = <WeaponObj>{ type: 'item', subtype: 'weapon', weapon: new Weapon(null) }
        if (!this.rightHand) this.rightHand = <WeaponObj>{ type: 'item', subtype: 'weapon', weapon: new Weapon(null) }

        // set them in their proper idle state for the weapon
        this.art = this.getAnimation('idle')
    }

    updateStaticAnim(): void {
        var time = heart.timer.getTime()
        var fps = 8 // todo: get FPS from image info

        if (time - this.lastFrameTime >= 1000 / fps) {
            this.frame++
            this.lastFrameTime = time

            if (this.frame === globalState.imageInfo[this.art].numFrames) {
                // animation is done
                if (this.animCallback) this.animCallback()
            }
        }
    }

    updateAnim(): void {
        if (!this.anim || this.anim === 'idle') return
        if (animInfo[this.anim].type === 'static') return this.updateStaticAnim()

        var time = heart.timer.getTime()
        var fps = globalState.imageInfo[this.art].fps
        var targetScreen = hexToScreen(this.path.target.x, this.path.target.y)

        var partials = getAnimPartialActions(this.art, this.anim)
        var currentPartial = partials.actions[this.path.partial]

        if (time - this.lastFrameTime >= 1000 / fps) {
            // advance frame
            this.lastFrameTime = time

            if (this.frame === currentPartial.endFrame || this.frame + 1 >= globalState.imageInfo[this.art].numFrames) {
                // completed an action frame (partial action)

                // do we have another partial action?
                if (this.path.partial + 1 < partials.actions.length) {
                    // then proceed to next partial action
                    this.path.partial++
                } else {
                    // otherwise we're done animating this, loop
                    this.path.partial = 0
                }

                // move to the start of the next partial action
                // we're already on its startFrame which coincides with the current endFrame,
                // so we add one to get to the next frame.
                // unless we're the first one, in which case just 0.
                var nextFrame = partials.actions[this.path.partial].startFrame + 1
                if (this.path.partial === 0) nextFrame = 0
                this.frame = nextFrame

                // reset shift
                this.shift = { x: 0, y: 0 }

                // move to new path hex
                var pos = this.path.path[this.path.index++]
                var hex = { x: pos[0], y: pos[1] }

                if (!this.move(hex)) return
                if (!this.path)
                    // it's possible for move() to have side effects which can clear the anim
                    return

                // set orientation towards new path hex
                pos = this.path.path[this.path.index]
                if (pos) {
                    const dir = directionOfDelta(this.position.x, this.position.y, pos[0], pos[1])
                    if (dir == null) throw Error()
                    this.orientation = dir
                }
            } else {
                // advance frame
                this.frame++

                var info = globalState.imageInfo[this.art]
                if (info === undefined) throw 'No image map info for: ' + this.art

                // add the new frame's offset to our shift
                var frameInfo = info.frameOffsets[this.orientation][this.frame]
                this.shift.x += frameInfo.x
                this.shift.y += frameInfo.y
            }

            if (this.position.x === this.path.target.x && this.position.y === this.path.target.y) {
                // reached target position
                // TODO: better logging system
                //console.log("target reached")

                var callback = this.animCallback
                this.clearAnim()

                if (callback) callback()
            }
        }
    }

    blocks(): boolean {
        return this.dead !== true && this.visible !== false
    }

    inAnim(): boolean {
        return !!(this.path || this.animCallback)
    }

    move(position: Point, curIdx?: number, signalEvents: boolean = true): boolean {
        if (!super.move(position, curIdx, signalEvents)) return false

        if (Config.engine.doSpatials !== false) {
            var hitSpatials = hitSpatialTrigger(position)
            for (var i = 0; i < hitSpatials.length; i++) {
                var spatial = hitSpatials[i]
                console.log(
                    'triggered spatial ' +
                        spatial.script +
                        ' (' +
                        spatial.range +
                        ') @ ' +
                        spatial.position.x +
                        ', ' +
                        spatial.position.y
                )
                Scripting.spatial(spatial, this)
            }
        }

        return true
    }

    canRun(): boolean {
        return this.hasAnimation('run')
    }

    getSkill(skill: string) {
        return this.skills.get(skill, this.stats)
    }

    getStat(stat: string) {
        return this.stats.get(stat)
    }

    getBase(): string {
        return this.art.slice(0, -2)
    }

    get equippedWeapon(): WeaponObj | null {
        // TODO: Get actual selection
        if (objectIsWeapon(this.leftHand)) return this.leftHand || null
        if (objectIsWeapon(this.rightHand)) return this.rightHand || null
        return null
    }

    getAnimation(anim: string): string {
        var base = this.getBase()

        // try weapon animation first
        var weaponObj = this.equippedWeapon
        if (weaponObj !== null && Config.engine.doUseWeaponModel === true) {
            if (!weaponObj.weapon) throw Error()
            var wepAnim = weaponObj.weapon.getAnim(anim)
            if (wepAnim) return base + wepAnim
        }

        var wep = 'a'
        switch (anim) {
            case 'attack':
                console.log('default attack animation instead of weapon animation.')
                return base + wep + 'a'
            case 'idle':
                return base + wep + 'a'
            case 'walk':
                return base + wep + 'b'
            case 'run':
                return base + wep + 't'
            case 'shoot':
                return base + wep + 'j'
            case 'weapon-reload':
                return base + wep + 'a'
            case 'static-idle':
                return base + wep + 'a'
            case 'static':
                return this.art
            case 'hitFront':
                return base + 'ao'
            case 'use':
                return base + 'al'
            case 'pickUp':
                return base + 'ak'
            case 'climb':
                return base + 'ae'
            //case "punch": return base + 'aq'
            case 'called-shot':
                return base + 'na'
            case 'death':
                if (this.pro && this.pro.extra.killType === 18) {
                    // Boss is special-cased
                    console.log('Boss death...')
                    return base + 'bl'
                }
                return base + 'bo' // TODO: choose death animation better
            case 'death-explode':
                return base + 'bl'
            default:
                throw 'Unknown animation: ' + anim
        }
    }

    hasAnimation(anim: string): boolean {
        return globalState.imageInfo[this.getAnimation(anim)] !== undefined
    }

    get killType(): number | null {
        if (this.isPlayer) return 19 // last type
        if (!this.pro || !this.pro.extra) return null
        return this.pro.extra.killType
    }

    staticAnimation(anim: string, callback?: () => void, waitForLoad: boolean = true): void {
        this.art = this.getAnimation(anim)
        this.frame = 0
        this.lastFrameTime = 0

        if (waitForLoad) {
            lazyLoadImage(this.art, () => {
                this.anim = anim
                this.animCallback = callback || (() => this.clearAnim())
            })
        } else {
            this.anim = anim
            this.animCallback = callback || (() => this.clearAnim())
        }
    }

    get directionalOffset(): Point {
        var info = globalState.imageInfo[this.art]
        if (info === undefined) throw 'No image map info for: ' + this.art
        return info.directionOffsets[this.orientation]
    }

    clearAnim(): void {
        super.clearAnim()
        this.path = null

        // reset to idle pose
        this.anim = 'idle'
        this.art = this.getAnimation('idle')
    }

    walkTo(target: Point, running?: boolean, callback?: () => void, maxLength?: number, path?: any): boolean {
        // pathfind and set walking to target
        if (this.position.x === target.x && this.position.y === target.y) {
            // can't walk to the same tile
            return false
        }

        if (path === undefined) path = globalState.gMap.recalcPath(this.position, target)

        if (path.length === 0) {
            // no path
            //console.log("not a valid path")
            return false
        }

        if (maxLength !== undefined && path.length > maxLength) {
            console.log('truncating path (to length ' + maxLength + ')')
            path = path.slice(0, maxLength + 1)
        }

        // some critters can't run
        if (running && !this.canRun()) running = false

        // set up animation properties
        var actualTarget = { x: path[path.length - 1][0], y: path[path.length - 1][1] }
        this.path = { path: path, index: 1, target: actualTarget, partial: 0 }
        this.anim = running ? 'run' : 'walk'
        this.art = this.getAnimation(this.anim)
        this.animCallback = callback || (() => this.clearAnim())
        this.frame = 0
        this.lastFrameTime = heart.timer.getTime()
        this.shift = { x: 0, y: 0 }
        const dir = directionOfDelta(this.position.x, this.position.y, path[1][0], path[1][1])
        if (dir == null) throw Error()
        this.orientation = dir
        //console.log("start dir: %o", this.orientation)

        return true
    }

    walkInFrontOf(targetPos: Point, callback?: () => void): boolean {
        var path = globalState.gMap.recalcPath(this.position, targetPos, false)
        if (path.length === 0)
            // invalid path
            return false
        else if (path.length <= 2) {
            // we're already infront of or on it
            if (callback) callback()
            return true
        }
        path.pop() // we don't want targetPos in the path

        var target = path[path.length - 1]
        targetPos = { x: target[0], y: target[1] }

        var running = Config.engine.doAlwaysRun
        if (hexDistance(this.position, targetPos) > 5) running = true

        //console.log("path: %o, callback %o", path, callback)
        return this.walkTo(targetPos, running, callback, undefined, path)
    }

    serialize(): SerializedCritter {
        const obj = <SerializedCritter>super.serialize()

        for (const prop of SERIALIZED_CRITTER_PROPS) {
            // console.log(`saving prop ${prop} from SerializedCritter = ${this[prop]}`);
            ;(<any>obj)[prop] = (<any>this)[prop]
        }

        return obj
    }
}
