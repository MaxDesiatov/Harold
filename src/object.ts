/*
Copyright 2014 darkf

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

import { Critter, Weapon } from './critter.js'
import { getLstId, lookupScriptName } from './data.js'
import { Events } from './events.js'
import { heart } from './heart.js'
import { hexesInRadius, Point } from './geometry.js'
import globalState from './globalState.js'
import { lazyLoadImage } from './images.js'
import { Lightmap } from './lightmap.js'
import { getPROSubTypeName, getPROTypeName, loadPRO, lookupArt, makePID } from './pro.js'
import { Scripting } from './scripting.js'
import { fromTileNum } from './tile.js'
import { uiLoot } from './ui.js'
import { deepClone, getMessage } from './util.js'
import { Config } from './config.js'

// Collection of functions for working with game objects

let _lastObjectUID = 0

export function objectIsWeapon(obj: any): boolean {
    if (obj === undefined || obj === null) return false
    //return obj.type === "item" && obj.pro.extra.subType === 3 // weapon subtype
    return obj.weapon !== undefined
}

function objectFindItemIndex(obj: Obj, item: Obj): number {
    for (var i = 0; i < obj.inventory.length; i++) {
        if (obj.inventory[i].pid === item.pid) return i
    }
    return -1
}

export function cloneItem(item: Obj): Obj {
    return Object.assign({}, item)
}

function objectSwapItem(a: Obj, item: Obj, b: Obj, amount: number) {
    // swap item from a -> b
    if (amount === 0) return

    var idx = objectFindItemIndex(a, item)
    if (idx === -1) throw 'item (' + item + ') does not exist in a'
    if (amount !== undefined && amount < item.amount) {
        // just deduct amount from a and give amount to b
        item.amount -= amount
        b.addInventoryItem(cloneItem(item), amount)
    } else {
        // just swap them
        a.inventory.splice(idx, 1)
        b.addInventoryItem(item, amount || 1)
    }
}

export function objectGetDamageType(obj: any): string {
    // TODO: any (where does dmgType go? WeaponObj?)
    if (obj.dmgType !== undefined) return obj.dmgType
    throw 'no damage type for obj: ' + obj
}

function useExplosive(obj: Obj, source: Critter): void {
    if (source.isPlayer !== true) return // ?
    var mins, secs

    while (true) {
        var time = prompt('Time to detonate?', '1:00')
        if (time === null) return // cancel
        var s = time.split(':')
        if (s.length !== 2) continue

        mins = parseInt(s[0])
        secs = parseInt(s[1])

        if (isNaN(mins) || isNaN(secs)) continue
        break
    }

    // TODO: skill rolls

    var ticks = mins * 60 * 10 + secs * 10 // game ticks until detonation

    console.log('arming explosive for ' + ticks + ' ticks')

    Scripting.timeEventList.push({
        ticks: ticks,
        obj: null,
        userdata: null,
        fn: function () {
            // explode!
            // TODO: explosion damage calculations
            obj.explode(source, 10 /* min dmg */, 25 /* max dmg */)
        },
    })
}

// Set the object (door/container) open/closed; returns true if possible, false if not (e.g. locked)
function setObjectOpen(obj: Obj, open: boolean, loot: boolean = true, signalEvent: boolean = true): boolean {
    if (!obj.isDoor && !obj.isContainer) return false

    // Open/closable doors/containers
    // TODO: Door/Container subclasses
    if (obj.locked) return false

    obj.open = open

    if (signalEvent) {
        Events.emit('objSetOpen', { obj, open })
        Events.emit(open ? 'objOpen' : 'objClose', { obj })
    }

    // Animate open/closed
    obj.singleAnimation(!open, function () {
        obj.anim = null
        if (loot && obj.isContainer && open) {
            // loot a container
            uiLoot(obj)
        }
    })

    return true
}

// Toggle the object (door/container) open/closed; returns true if possible, false if not (e.g. locked)
function toggleObjectOpen(obj: Obj, loot: boolean = true, signalEvent: boolean = true): boolean {
    return setObjectOpen(obj, !obj.open, loot, signalEvent)
}

function objectFindIndex(obj: Obj): number {
    return globalState.gMap.getObjects().findIndex((object) => object === obj)
}

function objectZCompare(a: Obj, b: Obj): number {
    var aY = a.position.y
    var bY = b.position.y

    var aX = a.position.x
    var bX = b.position.x

    if (aY === bY) {
        if (aX < bX) return -1
        else if (aX > bX) return 1
        else if (aX === bX) {
            if (a.type === 'wall') return -1
            else if (b.type === 'wall') return 1
            else return 0
        }
    } else if (aY < bY) return -1
    else if (aY > bY) return 1

    throw 'unreachable'
}

function objectZOrder(obj: Obj, index: number): void {
    var oldIdx = index !== undefined ? index : objectFindIndex(obj)
    if (oldIdx === -1) {
        console.log('objectZOrder: no such object...')
        return
    }

    // TOOD: mutable/potentially unsafe usage of getObjects
    var objects = globalState.gMap.getObjects()

    objects.splice(oldIdx, 1) // remove the object...

    var inserted = false
    for (var i = 0; i < objects.length; i++) {
        var zc = objectZCompare(obj, objects[i])
        if (zc === -1) {
            objects.splice(i, 0, obj) // insert at new index
            inserted = true
            break
        }
    }

    if (!inserted)
        // couldn't find a spot, just add it in
        objects.push(obj)
}

function zsort(objects: Obj[]): void {
    objects.sort(objectZCompare)
}

export interface SerializedObj {
    uid: number

    pid: number
    pidID: number
    type: string
    pro: any
    flags: number
    art: string
    frmPID: number
    orientation: number
    visible: boolean

    extra: any

    script: string
    _script: Scripting.SerializedScript | undefined

    name: string
    subtype: string
    invArt: string

    frame: number

    amount: number
    position: Point
    inventory: SerializedObj[]

    lightRadius: number
    lightIntensity: number
}

export class Obj {
    uid: number = -1 // Unique ID given to all objects, to distinguish objects with the same PIDs

    pid: number // PID (Prototype IDentifier)
    pidID: number // ID (not type) part of the PID
    type: string = null // TODO: enum // Type of object (critter, item, ...)
    pro: any = null // TODO: pro ref // PRO Object
    flags: number = 0 // Flags from PRO; may be overriden by map objects
    art: string // TODO: Path // Art path
    frmPID: number = null // Art FID
    orientation: number = null // Direction the object is facing
    visible: boolean = true // Is the object visible?
    open: boolean = false // Is the object open? (Mainly for doors)
    locked: boolean = false // Is the object locked? (Mainly for doors)

    extra: any // TODO

    script: string // Script name
    _script: Scripting.Script | undefined // Live script object

    // TOOD: unify these
    name: string // = "<unnamed obj>"; // Only for some critters at the moment.
    subtype: string // Some objects, like items and scenery, have subtypes
    invArt: string // Art path used for in-inventory image

    anim: any = null // Current animation (TODO: Is this only a string? It should probably be an enum.)
    animCallback: any = null // Callback when current animation is finished playing
    frame: number = 0 // Animation frame index
    lastFrameTime: number = 0 // Time since last animation frame played

    // Frame shift/offset
    // For static animations, this is just null (effectively just the frame offset as declared in the .FRM),
    // but for walk/run animations it is the sum of frame offsets between the last action frame
    // and the current frame.
    shift: Point = null

    // Outline color, if outlined
    outline: string | null = null

    amount: number = 1 // TODO: Where does this belong? Items and misc seem to have it, or is Money an Item?
    position: Point = { x: -1, y: -1 }
    inventory: Obj[] = []

    // TODO: verify
    lightRadius: number = 0
    lightIntensity: number = 655

    static fromPID(pid: number, sid?: number): Obj {
        return Obj.fromPID_(new Obj(), pid, sid)
    }

    static fromPID_<T extends Obj>(obj: T, pid: number, sid?: number): T {
        console.log(`fromPID: pid=${pid}, sid=${sid}`)
        var pidType = (pid >> 24) & 0xff
        var pidID = pid & 0xffff

        var pro: any = loadPRO(pid, pidID) // TODO: any
        obj.type = getPROTypeName(pidType)
        obj.pid = pid
        obj.pro = pro
        obj.flags = obj.pro.flags

        // TODO: Subclasses
        if (pidType == 0) {
            // item
            obj.subtype = getPROSubTypeName(pro.extra.subtype)
            obj.name = getMessage('pro_item', pro.textID)

            var invPID = pro.extra.invFRM & 0xffff
            console.log(`invPID: ${invPID}, pid=${pid}`)
            if (invPID !== 0xffff) obj.invArt = 'art/inven/' + getLstId('art/inven/inven', invPID).split('.')[0]
        }

        if (obj.pro !== undefined) obj.art = lookupArt(makePID(obj.pro.frmType, obj.pro.frmPID))
        else obj.art = 'art/items/RESERVED'

        obj.init()
        obj.loadScript(sid)
        return obj
    }

    static fromMapObject(mobj: any, deserializing: boolean = false): Obj {
        return Obj.fromMapObject_(new Obj(), mobj, deserializing)
    }

    static fromMapObject_<T extends Obj>(obj: T, mobj: any, deserializing: boolean = false): T {
        // Load an Obj from a map object
        //console.log("fromMapObject: %o", mobj)
        if (mobj.uid) obj.uid = mobj.uid
        obj.pid = mobj.pid
        obj.pidID = mobj.pidID
        obj.frmPID = mobj.frmPID
        obj.orientation = mobj.orientation
        if (obj.type === null) obj.type = mobj.type
        obj.art = mobj.art
        obj.position = mobj.position
        obj.lightRadius = mobj.lightRadius
        obj.lightIntensity = mobj.lightIntensity
        obj.subtype = mobj.subtype
        obj.amount = mobj.amount
        obj.inventory = mobj.inventory
        obj.script = mobj.script
        obj.extra = mobj.extra

        obj.pro = mobj.pro || loadPRO(obj.pid, obj.pidID)
        obj.flags = mobj.flags // NOTE: Tested with two objects in Mapper, map object flags seem to inherit PROs already and should thus use them

        // etc? TODO: check this!

        obj.init()

        if (deserializing) {
            obj.inventory = mobj.inventory.map((obj: SerializedObj) => deserializeObj(obj))
            obj.script = mobj.script

            if (mobj._script) obj._script = Scripting.deserializeScript(mobj._script)

            // TODO: Should we load the script if mobj._script does not exist?
        } else if (Config.engine.doLoadScripts) obj.loadScript()

        return obj
    }

    init() {
        if (this.uid === -1) this.uid = _lastObjectUID++

        //console.log("init: %o", this)
        if (this.inventory !== undefined)
            // containers and critters
            this.inventory = this.inventory.map((obj) => objFromMapObject(obj))
    }

    loadScript(sid: number = -1): void {
        var scriptName = null

        if (sid >= 0) scriptName = lookupScriptName(sid)
        else if (this.script) scriptName = this.script
        else if (this.pro) {
            if (this.pro.extra !== undefined && this.pro.extra.scriptID >= 0) {
                // scriptName = lookupScriptName(this.pro.extra.scriptID & 0xffff)
                console.warn(
                    `PRO says sid is ${
                        this.pro.extra.scriptID & 0xffff
                    } (${scriptName}), but we're not ascribing it one (test)`
                )
            } else if (this.pro.scriptID >= 0) {
                // scriptName = lookupScriptName(this.pro.scriptID & 0xffff)
                console.warn(
                    `PRO says sid is ${
                        this.pro.extra.scriptID & 0xffff
                    } (${scriptName}), but we're not ascribing it one (test)`
                )
            }
        }

        if (scriptName != null) {
            if (Config.engine.doLogScriptLoads) console.log('loadScript: loading %s (sid=%d)', scriptName, sid)
            // console.trace();
            var script = Scripting.loadScript(scriptName)
            if (!script) {
                console.log('loadScript: load script failed for %s (sid=%d)', scriptName, sid)
            } else {
                this.script = scriptName
                this._script = script
                Scripting.initScript(this._script, this)
            }
        }
    }

    enterMap(): void {
        // TODO: do we updateMap?
        // TODO: is this correct?
        // TODO: map objects should be a registry, and this should be activated when objects
        // are added in. @important

        if (this._script) Scripting.objectEnterMap(this, globalState.currentElevation, globalState.gMap.mapID)
    }

    setAmount(amount: number): Obj {
        this.amount = amount
        return this
    }

    // Moves the object; returns `true` if successfully moved,
    // or `false` if interrupted (such as by an exit grid).
    move(position: Point, curIdx?: number, signalEvents: boolean = true): boolean {
        this.position = position

        if (signalEvents) Events.emit('objMove', { obj: this, position })

        // rebuild the lightmap
        if (Config.engine.doFloorLighting) Lightmap.rebuildLight()

        // give us a new z-order
        if (Config.engine.doZOrder !== false) objectZOrder(this, curIdx)

        return true
    }

    updateAnim(): void {
        if (!this.anim) return
        var time = heart.timer.getTime()
        var fps = globalState.imageInfo[this.art].fps
        if (fps === 0) fps = 10 // XXX: ?

        if (time - this.lastFrameTime >= 1000 / fps) {
            if (this.anim === 'reverse') this.frame--
            else this.frame++
            this.lastFrameTime = time

            if (this.frame === -1 || this.frame === globalState.imageInfo[this.art].numFrames) {
                // animation is done
                if (this.anim === 'reverse') this.frame++
                else this.frame--
                if (this.animCallback) this.animCallback()
            }
        }
    }

    blocks(): boolean {
        // TODO: We could make use of subclass polymorphism to reduce the cases here
        // NOTE: This may be overloaded in subclasses

        if (this.type === 'misc') return false
        if (!this.pro) return true // XXX: ?
        if (this.subtype === 'door') return !this.open
        if (this.visible === false) return false

        return !((this.pro.flags & 0x00000010) /* NoBlock */)
    }

    inAnim(): boolean {
        return !!this.animCallback // TODO: find a better way
    }

    // Clear any animation the object has
    clearAnim(): void {
        this.frame = 0
        this.animCallback = null
        this.anim = null
        this.shift = null
    }

    singleAnimation(reversed?: boolean, callback?: () => void): void {
        if (reversed) this.frame = globalState.imageInfo[this.art].numFrames - 1
        else this.frame = 0
        this.lastFrameTime = 0
        this.anim = reversed ? 'reverse' : 'single'
        this.animCallback =
            callback ||
            (() => {
                this.anim = null
            })
    }

    // Are two objects approximately (not necessarily strictly) equal?
    approxEq(obj: Obj) {
        return this.pid === obj.pid
    }

    clone(): Obj {
        // TODO: check this and probably fix it

        // If we have a script, temporarily remove it so that we may clone the
        // object without the script, and then re-load it for a new instance.
        if (this._script) {
            console.log('cloning an object with a script: %o', this)
            var _script = this._script
            this._script = null
            var obj = deepClone(this)
            this._script = _script
            obj.loadScript() // load new copy of the script
            return obj
        }

        // no script, just deep clone the object
        return deepClone(this)
    }

    addInventoryItem(item: Obj, count: number = 1): void {
        for (var i = 0; i < this.inventory.length; i++) {
            if (this.inventory[i].approxEq(item)) {
                this.inventory[i].amount += count
                return
            }
        }

        // no existing item, add new inventory object
        const clone = item.clone()
        clone.setAmount = this.setAmount

        this.inventory.push(clone.setAmount(count))
    }

    getMessageCategory(): string {
        const categories: { [category: string]: string } = {
            item: 'pro_item',
            critter: 'pro_crit',
            scenery: 'pro_scen',
            wall: 'pro_wall',
            misc: 'pro_misc',
        }
        return categories[this.type]
    }

    getDescription(): string {
        if (!this.pro) return null

        return getMessage(this.getMessageCategory(), this.pro.textID + 1) || null
    }

    get money(): number {
        const MONEY_PID = 41
        for (var i = 0; i < this.inventory.length; i++) {
            if (this.inventory[i].pid === MONEY_PID) {
                return this.inventory[i].amount
            }
        }

        return 0
    }

    get isDoor(): boolean {
        return this.type === 'scenery' && this.pro.extra.subType === 0 // SCENERY_DOOR
    }

    get isStairs(): boolean {
        return this.type === 'scenery' && this.pro.extra.subType === 1 // SCENERY_STAIRS
    }

    get isLadder(): boolean {
        return (
            this.type === 'scenery' &&
            (this.pro.extra.subType === 3 || // SCENERY_LADDER_BOTTOM
                this.pro.extra.subType === 4)
        ) // SCENERY_LADDER_TOP
    }

    get isContainer(): boolean {
        return this.type === 'item' && this.pro.extra.subType === 1 // SUBTYPE_CONTAINER
    }

    get isExplosive(): boolean {
        return this.pid === 85 /* Plastic Explosives */ || this.pid === 51 /* Dynamite */
    }

    get isSelectable(): boolean {
        return this.visible !== false && (this.canUse || this.type === 'critter')
    }

    get canUse(): boolean {
        if (this._script !== undefined && this._script.use_p_proc !== undefined) return true
        else if (this.type === 'item' || this.type === 'scenery')
            if (this.isDoor || this.isStairs || this.isLadder) return true
            else return (this.pro.extra.actionFlags & 8) != 0
        return false
    }

    // Returns whether or not the object was used
    use(source?: Critter, useScript?: boolean): boolean {
        if (this.canUse === false) {
            console.log("can't use object")
            return false
        }

        if (useScript !== false && this._script && this._script.use_p_proc !== undefined) {
            if (source === undefined) source = globalState.player
            if (Scripting.use(this, source) === true) {
                console.log('useObject: overriden')
                return true // script overrided us
            }
        } else if (this.script !== undefined && !this._script)
            console.log('object used has script but is not loaded: ' + this.script)

        if (this.isExplosive) {
            useExplosive(this, source)
            return true
        }

        if (this.isDoor || this.isContainer) {
            toggleObjectOpen(this, true, true)
        } else if (this.isStairs) {
            var destTile = fromTileNum(this.extra.destination & 0xffff)
            var destElev = ((this.extra.destination >> 28) & 0xf) >> 1

            if (this.extra.destinationMap === -1 && this.extra.destination !== -1) {
                // same map, new destination
                console.log('stairs: tile: ' + destTile.x + ', ' + destTile.y + ', elev: ' + destElev)

                globalState.player.position = destTile
                globalState.gMap.changeElevation(destElev)
            } else {
                console.log(
                    'stairs -> ' +
                        this.extra.destinationMap +
                        ' @ ' +
                        destTile.x +
                        ', ' +
                        destTile.y +
                        ', elev: ' +
                        destElev
                )
                globalState.gMap.loadMapByID(this.extra.destinationMap, destTile, destElev)
            }
        } else if (this.isLadder) {
            var isTop = this.pro.extra.subType === 4
            var level = isTop ? globalState.currentElevation + 1 : globalState.currentElevation - 1
            var destTile = fromTileNum(this.extra.destination & 0xffff)
            // TODO: destination also supposedly contains elevation and map
            console.log('ladder (' + (isTop ? 'top' : 'bottom') + ' -> level ' + level + ')')
            globalState.player.position = destTile
            globalState.gMap.changeElevation(level)
        } else {
            this.singleAnimation()
        }

        globalState.gMap.updateMap()
        return true
    }

    explode(source: Obj, minDmg: number, maxDmg: number): void {
        var damage = maxDmg
        var explosion = createObjectWithPID(makePID(5 /* misc */, 14 /* Explosion */), -1)
        explosion.position.x = this.position.x
        explosion.position.y = this.position.y
        ;(<any>this).dmgType = 'explosion' // TODO: any (WeaponObj?)

        lazyLoadImage(explosion.art, () => {
            globalState.gMap.addObject(explosion)

            console.log('adding explosion')
            explosion.singleAnimation(false, () => {
                globalState.gMap.destroyObject(explosion)

                // damage critters in a radius
                var hexes = hexesInRadius(this.position, 8 /* explosion radius */) // TODO: radius
                for (var i = 0; i < hexes.length; i++) {
                    var objs = globalState.gMap.objectsAtPosition(hexes[i])
                    for (var j = 0; j < objs.length; j++) {
                        if (objs[j].type === 'critter') console.log('todo: damage', (<Critter>objs[j]).name)

                        Scripting.damage(objs[j], this, this /*source*/, damage)
                    }
                }

                // remove explosive
                globalState.gMap.destroyObject(this)
            })
        })
    }

    pickup(source: Critter) {
        if (this._script) {
            console.log('picking up %o', this)
            Scripting.pickup(this, source)
        }
    }

    drop(source: Obj) {
        // drop inventory object obj from source
        var removed = false
        for (var i = 0; i < source.inventory.length; i++) {
            if (source.inventory[i].pid === this.pid) {
                removed = true
                source.inventory.splice(i, 1) // remove from source
                break
            }
        }
        if (!removed) throw "dropObject: couldn't find object"

        globalState.gMap.addObject(this) // add to objects
        var idx = globalState.gMap.getObjects().length - 1 // our new index
        this.move({ x: source.position.x, y: source.position.y }, idx)
    }

    // TODO: override this for subclasses
    serialize(): SerializedObj {
        return {
            uid: this.uid,
            pid: this.pid,
            pidID: this.pidID,
            type: this.type,
            pro: this.pro, // XXX: if pro changes in the future, this should be cloned
            flags: this.flags,
            art: this.art,
            frmPID: this.frmPID,
            orientation: this.orientation,
            visible: this.visible,
            extra: this.extra,
            script: this.script,
            _script: this._script ? this._script._serialize() : null,
            name: this.name,
            subtype: this.subtype,
            invArt: this.invArt,
            frame: this.frame,
            amount: this.amount,
            position: { x: this.position.x, y: this.position.y },
            inventory: this.inventory.map((obj) => obj.serialize()),
            lightRadius: this.lightRadius,
            lightIntensity: this.lightIntensity,
        }
    }
}

class Item extends Obj {
    type = 'item'

    static fromPID(pid: number, sid?: number): Item {
        return Obj.fromPID_(new Item(), pid, sid)
    }

    static fromMapObject(mobj: any, deserializing: boolean = false): Item {
        return Obj.fromMapObject_(new Item(), mobj, deserializing)
    }

    init() {
        super.init()

        // load item inventory art
        if (this.pro === null) return
        this.name = getMessage('pro_item', this.pro.textID)

        var invPID = this.pro.extra.invFRM & 0xffff
        if (invPID !== 0xffff) this.invArt = 'art/inven/' + getLstId('art/inven/inven', invPID).split('.')[0]
    }
}

export class WeaponObj extends Item {
    weapon?: Weapon = null

    static fromPID(pid: number, sid?: number): WeaponObj {
        return Obj.fromPID_(new WeaponObj(), pid, sid)
    }

    static fromMapObject(mobj: any, deserializing: boolean = false): WeaponObj {
        return Obj.fromMapObject_(new WeaponObj(), mobj, deserializing)
    }

    init() {
        super.init()
        // TODO: Weapon initialization
        //console.log("Weapon init")
        this.weapon = new Weapon(this)
    }
}

class Scenery extends Obj {
    type = 'scenery'

    static fromPID(pid: number, sid?: number): Scenery {
        return Obj.fromPID_(new Scenery(), pid, sid)
    }

    static fromMapObject(mobj: any, deserializing: boolean = false): Scenery {
        return Obj.fromMapObject_(new Scenery(), mobj, deserializing)
    }

    init() {
        super.init()
        //console.log("Scenery init")

        if (!this.pro) return

        const subtypeMap: { [subtype: number]: string } = {
            0: 'door',
            1: 'stairs',
            2: 'elevator',
            3: 'ladder',
            4: 'ladder',
            5: 'generic',
        }
        this.subtype = subtypeMap[this.pro.extra.subType]
    }
}

class Door extends Scenery {
    static fromPID(pid: number, sid?: number): Door {
        return Obj.fromPID_(new Door(), pid, sid)
    }

    static fromMapObject(mobj: any, deserializing: boolean = false): Door {
        return Obj.fromMapObject_(new Door(), mobj, deserializing)
    }

    init() {
        super.init()
        //console.log("Door init")
    }
}

// Creates an object of a relevant type from a Prototype ID and an optional Script ID
export function createObjectWithPID(pid: number, sid?: number) {
    var pidType = (pid >> 24) & 0xff
    if (pidType == 1)
        // critter
        return Critter.fromPID(pid, sid)
    else if (pidType == 0) {
        // item
        var pro = loadPRO(pid, pid & 0xffff)
        if (pro && pro.extra && pro.extra.subType == 3) return WeaponObj.fromPID(pid, sid)
        else return Item.fromPID(pid, sid)
    } else if (pidType == 2) {
        // scenery
        var pro = loadPRO(pid, pid & 0xffff)
        if (pro && pro.extra && pro.extra.subType == 0) return Door.fromPID(pid, sid)
        else return Scenery.fromPID(pid, sid)
    } else return Obj.fromPID(pid, sid)
}

export function objFromMapObject(mobj: any, deserializing: boolean = false) {
    var pid = mobj.pid
    var pidType = (pid >> 24) & 0xff

    if (pidType == 1)
        // critter
        return Critter.fromMapObject(mobj, deserializing)
    else if (pidType == 0) {
        // item
        var pro = mobj.pro || loadPRO(pid, pid & 0xffff)
        if (pro && pro.extra && pro.extra.subType == 3) return WeaponObj.fromMapObject(mobj, deserializing)
        else return Item.fromMapObject(mobj, deserializing)
    } else if (pidType == 2) {
        // scenery
        var pro = mobj.pro || loadPRO(pid, pid & 0xffff)
        if (pro && pro.extra && pro.extra.subType == 0) return Door.fromMapObject(mobj, deserializing)
        else return Scenery.fromMapObject(mobj, deserializing)
    } else return Obj.fromMapObject(mobj, deserializing)
}

export function deserializeObj(mobj: SerializedObj) {
    return objFromMapObject(mobj, true)
}
