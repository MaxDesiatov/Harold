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

import { Combat } from './combat.js'
import { Area, Elevator, loadAreas, lookupMapNameFromLookup } from './data.js'
import globalState from './globalState.js'
import { Critter, cloneItem, Obj } from './object.js'
import { Player } from './player.js'
import { lookupInterfaceArt } from './pro.js'
import { objectBoundingBox } from './renderer.js'
import { SaveLoad } from './saveload.js'
import { Scripting } from './scripting.js'
import { Skills } from './skills.js'
import { fromTileNum } from './tile.js'
import { playerUse } from './main.js'
import { pad } from './util.js'
import { Worldmap } from './worldmap.js'
import { Config } from './config.js'

// UI system

// TODO: reduce code duplication, circular references,
//       and general badness/unmaintainability.
// TODO: combat UI on main bar
// TODO: stats/info view in inventory screen
// TODO: fix inventory image size
// TODO: fix style for inventory image amount
// TODO: option for scaling the UI

module Ui {
    // Container that all of the top-level UI elements reside in
    let $uiContainer: HTMLElement

    export function init() {
        $uiContainer = document.getElementById('game-container')!

        initSkilldex()
        // initCharacterScreen();

        document.getElementById('chrButton')!.onclick = () => {
            characterWindow && characterWindow.close()
            initCharacterScreen()
        }
    }

    // Bounding box that accepts strings as well as numbers
    export interface CSSBoundingBox {
        x: number | string
        y: number | string
        w: number | string
        h: number | string
    }

    export class WindowFrame {
        children: Widget[] = []
        elem: HTMLElement
        showing: boolean = false

        constructor(public background: string, public bbox: CSSBoundingBox, children?: Widget[]) {
            this.elem = document.createElement('div')

            Object.assign(this.elem.style, {
                position: 'absolute',
                left: `${bbox.x}px`,
                top: `${bbox.y}px`,
                width: `${bbox.w}px`,
                height: `${bbox.h}px`,
                backgroundImage: `url('${background}')`,
            })

            if (children) {
                for (const child of children) this.add(child)
            }
        }

        add(widget: Widget): this {
            this.children.push(widget)
            this.elem.appendChild(widget.elem)
            return this
        }

        show(): this {
            if (this.showing) return this
            this.showing = true
            $uiContainer.appendChild(this.elem)
            return this
        }

        close(): void {
            if (!this.showing) return
            this.showing = false
            this.elem.parentNode!.removeChild(this.elem)
        }

        toggle(): this {
            if (this.showing) this.close()
            else this.show()
            return this
        }
    }

    export class Widget {
        elem: HTMLElement
        hoverBackground: string | null = null
        mouseDownBackground: string | null = null

        constructor(public background: string | null, public bbox: CSSBoundingBox) {
            this.elem = document.createElement('div')

            Object.assign(this.elem.style, {
                position: 'absolute',
                left: `${bbox.x}px`,
                top: `${bbox.y}px`,
                width: `${bbox.w}px`,
                height: `${bbox.h}px`,
                backgroundImage: background && `url('${background}')`,
            })
        }

        onClick(fn: (widget?: Widget) => void): this {
            this.elem.onclick = () => {
                fn(this)
            }
            return this
        }

        hoverBG(background: string): this {
            this.hoverBackground = background

            if (!this.elem.onmouseenter) {
                // Set up events for hovering/not hovering
                this.elem.onmouseenter = () => {
                    this.elem.style.backgroundImage = `url('${this.hoverBackground}')`
                }
                this.elem.onmouseleave = () => {
                    this.elem.style.backgroundImage = `url('${this.background}')`
                }
            }

            return this
        }

        mouseDownBG(background: string): this {
            this.mouseDownBackground = background

            if (!this.elem.onmousedown) {
                // Set up events for mouse down/up
                this.elem.onmousedown = () => {
                    this.elem.style.backgroundImage = `url('${this.mouseDownBackground}')`
                }
                this.elem.onmouseup = () => {
                    this.elem.style.backgroundImage = `url('${this.background}')`
                }
            }

            return this
        }

        css(props: object): this {
            Object.assign(this.elem.style, props)
            return this
        }
    }

    export class SmallButton extends Widget {
        constructor(x: number, y: number) {
            super('art/intrface/lilredup.png', { x, y, w: 15, h: 16 })
            this.mouseDownBG('art/intrface/lilreddn.png')
        }
    }

    export class Label extends Widget {
        constructor(x: number, y: number, text: string, public textColor: string = 'yellow') {
            super(null, { x, y, w: 'auto', h: 'auto' })
            this.setText(text)
            this.elem.style.color = this.textColor
        }

        setText(text: string): void {
            this.elem.innerHTML = text
        }
    }

    interface ListItem {
        id?: any // identifier userdata
        uid?: number // unique identifier (filled in by List)
        text: string
        onSelected?: () => void
    }

    // TODO: disable-selection class
    export class List extends Widget {
        items: ListItem[] = []
        itemSelected?: (item: ListItem) => void
        currentlySelected: ListItem | null = null
        currentlySelectedElem: HTMLElement | null = null
        _lastUID: number = 0

        constructor(
            bbox: CSSBoundingBox,
            items?: ListItem[],
            public textColor: string = '#00FF00',
            public selectedTextColor: string = '#FCFC7C'
        ) {
            super(null, bbox)
            this.elem.style.color = this.textColor

            if (items) {
                for (const item of items) this.addItem(item)
            }
        }

        onItemSelected(fn: (item: ListItem) => void): this {
            this.itemSelected = fn
            return this
        }

        getSelection(): ListItem | null {
            return this.currentlySelected
        }

        // Select the given item (and optionally, give its element for performance reasons)
        select(item: ListItem, itemElem?: HTMLElement): boolean {
            if (!itemElem)
                // Find element belonging to this item
                itemElem = this.elem.querySelector(`[data-uid="${item.uid}"]`) as HTMLElement

            if (!itemElem) {
                console.warn(`Can't find item's element for item UID ${item.uid}`)
                return false
            }

            this.itemSelected && this.itemSelected(item)

            item.onSelected && item.onSelected()

            if (this.currentlySelectedElem)
                // Reset text color for old selection
                this.currentlySelectedElem.style.color = this.textColor

            // Use selection color for new selection
            itemElem.style.color = this.selectedTextColor

            this.currentlySelected = item
            this.currentlySelectedElem = itemElem

            return true
        }

        // Select item given by its id
        selectId(id: any): boolean {
            const item = this.items.filter((item) => item.id === id)[0]
            if (!item) return false
            this.select(item)
            return true
        }

        addItem(item: ListItem): ListItem {
            item.uid = this._lastUID++
            this.items.push(item)

            const itemElem = document.createElement('div')
            itemElem.style.cursor = 'pointer'
            itemElem.textContent = item.text
            itemElem.setAttribute('data-uid', item.uid + '')
            itemElem.onclick = () => {
                this.select(item, itemElem)
            }
            this.elem.appendChild(itemElem)

            // Select first item added
            if (!this.currentlySelected) this.select(item)

            return item
        }

        clear(): void {
            this.items.length = 0

            const node = this.elem
            while (node.firstChild) node.removeChild(node.firstChild)
        }
    }

    export let skilldexWindow: WindowFrame
    export let characterWindow: WindowFrame

    function initSkilldex() {
        function useSkill(skill: Skills) {
            return () => {
                skilldexWindow.close()
                globalState.uiMode = UIMode.useSkill
                globalState.skillMode = skill
                console.log('[UI] Using skill:', skill)
            }
        }

        skilldexWindow = new WindowFrame('art/intrface/skldxbox.png', {
            x: Config.ui.screenWidth - 185 - 5,
            y: Config.ui.screenHeight - 368,
            w: 185,
            h: 368,
        })
            .add(new Label(65, 13, 'Skilldex'))
            .add(new Label(25, 85, 'Lockpick').onClick(useSkill(Skills.Lockpick)))
            .add(new Label(25, 300, 'Repair').onClick(useSkill(Skills.Repair)))
    }

    function initCharacterScreen() {
        const skillList = new List({ x: 380, y: 27, w: 'auto', h: 'auto' })

        skillList.css({ fontSize: '0.75em' })

        characterWindow = new WindowFrame('art/intrface/edtredt.png', {
            x: Config.ui.screenWidth / 2 - 640 / 2,
            y: Config.ui.screenHeight / 2 - 480 / 2,
            w: 640,
            h: 480,
        })
            .add(new SmallButton(455, 454).onClick(() => {}))
            .add(new Label(455 + 18, 454, 'Done'))
            .add(
                new SmallButton(552, 454).onClick(() => {
                    characterWindow.close()
                })
            )
            .add(new Label(552 + 18, 454, 'Cancel'))
            .add(new Label(22, 6, 'Name'))
            .add(new Label(160, 6, 'Age'))
            .add(new Label(242, 6, 'Gender'))
            .add(
                new Label(33, 280, `Level: ${globalState.player.getStat('Level')}`).css({
                    fontSize: '0.75em',
                    color: '#00FF00',
                })
            )
            .add(
                new Label(33, 292, `Exp: ${globalState.player.getStat('Experience')}`).css({
                    fontSize: '0.75em',
                    color: '#00FF00',
                })
            )
            .add(new Label(380, 5, 'Skill'))
            .add(new Label(399, 233, 'Skill Points'))
            .add(
                new Label(
                    194,
                    45,
                    `Hit Points ${globalState.player.getStat('HP')}/${globalState.player.getStat('Max HP')}`
                ).css({ fontSize: '0.75em', color: '#00FF00' })
            )
            .add(skillList)
            .show()

        // TODO: Move these constants to their proper place

        const skills = [
            'Small Guns',
            'Big Guns',
            'Energy Weapons',
            'Unarmed',
            'Melee Weapons',
            'Throwing',
            'First Aid',
            'Doctor',
            'Sneak',
            'Lockpick',
            'Steal',
            'Traps',
            'Science',
            'Repair',
            'Speech',
            'Barter',
            'Gambling',
            'Outdoorsman',
        ]

        const stats = ['STR', 'PER', 'END', 'CHA', 'INT', 'AGI', 'LUK']

        // TODO: Use a list of widgets or something for stats instead of this hack
        const statWidgets: Label[] = []

        let selectedStat = stats[0]

        let n = 0
        for (const stat of stats) {
            const widget = new Label(20, 39 + n, '').css({ background: 'black', padding: '5px' })
            widget.onClick(() => {
                selectedStat = stat
            })
            statWidgets.push(widget)
            characterWindow.add(widget)
            n += 33
        }

        // TODO: (Re-)run this after window is shown / a level-up is invoked
        const newStatSet = globalState.player.stats.clone()
        const newSkillSet = globalState.player.skills.clone()

        // Skill Points / Tag Skills counter
        const skillPointCounter = new Label(522, 230, '').css({ background: 'black', padding: '5px' })
        characterWindow.add(skillPointCounter)

        const redrawStatsSkills = () => {
            // Draw skills
            skillList.clear() // TODO: setItemText or something

            for (const skill of skills)
                skillList.addItem({ text: `${skill} ${newSkillSet.get(skill, newStatSet)}%`, id: skill })

            // Draw stats
            for (let i = 0; i < stats.length; i++) {
                const stat = stats[i]
                statWidgets[i].setText(`${stat} - ${newStatSet.get(stat)}`)
            }

            // Update skill point counter
            skillPointCounter.setText(pad(newSkillSet.skillPoints, 2))
        }

        redrawStatsSkills()

        const isLevelUp = true // TODO
        const canChangeStats = true // TODO

        if (isLevelUp) {
            const modifySkill = (inc: boolean) => {
                const skill = skillList.getSelection()!.id
                console.log('skill: %s currently: %d', skill, newSkillSet.get(skill, newStatSet))

                if (inc) {
                    const changed = newSkillSet.incBase(skill)
                    if (!changed) {
                        console.warn('Not enough skill points!')
                    }
                } else {
                    newSkillSet.decBase(skill)
                }

                redrawStatsSkills()
            }

            const toggleTagSkill = () => {
                const skill = skillList.getSelection()!.id
                const tagged = newSkillSet.isTagged(skill)
                console.log('skill: %s currently: %d tagged: %s', skill, newSkillSet.get(skill, newStatSet), tagged)

                if (!tagged) newSkillSet.tag(skill)
                else newSkillSet.untag(skill)

                redrawStatsSkills()
            }

            const modifyStat = (change: number) => {
                console.log('stat: %s currently: %d', selectedStat, newStatSet.get(selectedStat))

                newStatSet.modifyBase(selectedStat, change)
                redrawStatsSkills()
            }

            // Skill level up buttons
            characterWindow.add(
                new Label(580, 236, '-').onClick(() => {
                    console.log('-')
                    modifySkill(false)
                })
            )
            characterWindow.add(
                new Label(600, 236, '+').onClick(() => {
                    console.log('+')
                    modifySkill(true)
                })
            )
            characterWindow.add(
                new Label(620, 236, 'Tag').onClick(() => {
                    console.log('Tag')
                    toggleTagSkill()
                })
            )

            // Stat level up buttons
            if (canChangeStats) {
                characterWindow.add(
                    new Label(115, 260, '-').onClick(() => {
                        console.log('-')
                        modifyStat(-1)
                    })
                )
                characterWindow.add(
                    new Label(135, 260, '+').onClick(() => {
                        console.log('+')
                        modifyStat(+1)
                    })
                )
            }
        }
    }
}

export enum UIMode {
    none = 0,
    dialogue = 1,
    barter = 2,
    loot = 3,
    inventory = 4,
    worldMap = 5,
    elevator = 6,
    calledShot = 7,
    skilldex = 8,
    useSkill = 9,
    contextMenu = 10,
    saveLoad = 11,
    char = 12,
}

// XXX: Should this throw if the element doesn't exist?
function $id(id: string): HTMLElement {
    return document.getElementById(id)!
}

function $img(id: string): HTMLImageElement {
    return document.getElementById(id) as HTMLImageElement
}

function $q(selector: string): HTMLElement {
    return document.querySelector(selector) as HTMLElement
}

function $qa(selector: string): HTMLElement[] {
    return Array.from(document.querySelectorAll(selector))
}

function clearEl($el: HTMLElement): void {
    $el.innerHTML = ''
}

function show($el: HTMLElement): void {
    $el.style.display = 'block'
}

function hide($el: HTMLElement): void {
    $el.style.display = 'none'
}

// TODO: Examine if we actually need visibility or we can replace them all with show/hide
export function showv($el: HTMLElement): void {
    $el.style.visibility = 'visible'
}

export function hidev($el: HTMLElement): void {
    $el.style.visibility = 'hidden'
}

function off($el: HTMLElement, events: string): void {
    const eventList = events.split(' ')
    for (const event of eventList) (<any>$el)['on' + event] = null
}

function appendHTML($el: HTMLElement, html: string): void {
    $el.insertAdjacentHTML('beforeend', html)
}

interface ElementOptions {
    id?: string
    src?: string
    classes?: string[]
    click?: (e: MouseEvent) => void
    style?: { [key in keyof CSSStyleDeclaration]?: string }
    children?: HTMLElement[]
    attrs?: { [key: string]: string | number }
}

export function makeEl(tag: string, options: ElementOptions): HTMLElement {
    const $el = document.createElement(tag)

    if (options.id !== undefined) $el.id = options.id
    if (options.src !== undefined) ($el as HTMLImageElement).src = options.src
    if (options.classes !== undefined) $el.className = options.classes.join(' ')
    if (options.click !== undefined) $el.onclick = options.click
    if (options.style !== undefined) Object.assign($el.style, options.style)
    if (options.children !== undefined) {
        for (const child of options.children) $el.appendChild(child)
    }
    if (options.attrs !== undefined) {
        for (const prop in options.attrs) $el.setAttribute(prop, options.attrs[prop] + '')
    }

    return $el
}

export function initUI() {
    Ui.init()

    makeDropTarget($id('inventoryBoxList'), (data: string) => {
        uiMoveSlot(data, 'inventory')
    })
    makeDropTarget($id('inventoryBoxItem1'), (data: string) => {
        uiMoveSlot(data, 'leftHand')
    })
    makeDropTarget($id('inventoryBoxItem2'), (data: string) => {
        uiMoveSlot(data, 'rightHand')
    })

    for (let i = 0; i < 2; i++) {
        for (const $chance of Array.from(document.querySelectorAll('#calledShotBox .calledShotChance')))
            $chance.appendChild(
                makeEl('div', { classes: ['number'], style: { left: i * 9 + 'px' }, id: 'digit' + (i + 1) })
            )
    }

    $id('calledShotCancelBtn').onclick = () => {
        uiCloseCalledShot()
    }

    /*
    $id("worldmapViewButton").onclick = () => {
        var onAreaMap = ($("#areamap").css("visibility") === "visible")
        if(onAreaMap)
            uiWorldMapWorldView()
        else {
            var currentArea = areaContainingMap(gMap.name)
            if(currentArea)
                uiWorldMapShowArea(currentArea)
            else
                uiWorldMapAreaView()
        }
    }
    */

    $id('inventoryButton').onclick = () => {
        uiInventoryScreen()
    }
    $id('inventoryDoneButton').onclick = () => {
        globalState.uiMode = UIMode.none
        $id('inventoryBox').style.visibility = 'hidden'
        uiDrawWeapon()
    }

    $id('lootBoxDoneButton').onclick = () => {
        uiEndLoot()
    }

    $id('attackButtonContainer').onclick = () => {
        if (!Config.engine.doCombat) return
        if (globalState.inCombat) {
            // TODO: targeting reticle for attacks
        } else {
            // begin combat
            Combat.start()
        }
    }

    $id('attackButtonContainer').oncontextmenu = () => {
        // right mouse button (cycle weapon modes)
        var wep = globalState.player.equippedWeapon
        if (!wep || !wep.weapon) return false
        wep.weapon.cycleMode()
        uiDrawWeapon()
        return false
    }

    $id('endTurnButton').onclick = () => {
        if (globalState.inCombat && globalState.combat!.inPlayerTurn) {
            if (globalState.player.anim !== null && globalState.player.anim !== 'idle') {
                console.log("Can't end turn while player is in an animation.")
                return
            }
            console.log('[TURN]')
            globalState.combat!.nextTurn()
        }
    }

    $id('endCombatButton').onclick = () => {
        if (globalState.inCombat) globalState.combat!.end()
    }

    $id('endContainer').addEventListener('animationiteration', uiEndCombatAnimationDone)
    $id('endContainer').addEventListener('webkitAnimationIteration', uiEndCombatAnimationDone)

    $id('skilldexButton').onclick = () => {
        Ui.skilldexWindow.toggle()
    }

    function makeScrollable($el: HTMLElement, scroll: number = 60) {
        $el.onwheel = (e: WheelEvent) => {
            const delta = e.deltaY > 0 ? 1 : -1
            $el.scrollTop = $el.scrollTop + scroll * delta
            e.preventDefault()
        }
    }

    makeScrollable($id('inventoryBoxList'))

    makeScrollable($id('barterBoxInventoryLeft'))
    makeScrollable($id('barterBoxInventoryRight'))
    makeScrollable($id('barterBoxLeft'))
    makeScrollable($id('barterBoxRight'))
    makeScrollable($id('lootBoxLeft'))
    makeScrollable($id('lootBoxRight'))
    makeScrollable($id('worldMapLabels'))
    makeScrollable($id('displayLog'))
    makeScrollable($id('dialogueBoxReply'), 30)

    drawHP(globalState.player.getStat('HP'))
    uiDrawWeapon()
}

function uiHideContextMenu() {
    globalState.uiMode = UIMode.none
    $id('itemContextMenu').style.visibility = 'hidden'
}

export function uiContextMenu(obj: Obj, evt: any) {
    globalState.uiMode = UIMode.contextMenu

    function button(obj: Obj, action: string, onclick: () => void) {
        return makeEl('img', {
            id: 'context_' + action,
            classes: ['itemContextMenuButton'],
            click: () => {
                onclick()
                uiHideContextMenu()
            },
        })
    }

    var $menu = $id('itemContextMenu')
    clearEl($menu)
    Object.assign($menu.style, {
        visibility: 'visible',
        left: `${evt.clientX}px`,
        top: `${evt.clientY}px`,
    })
    var cancelBtn = button(obj, 'cancel', () => {})
    var lookBtn = button(obj, 'look', () => uiLog('You see: ' + obj.getDescription()))
    var useBtn = button(obj, 'use', () => playerUse()) // TODO: playerUse should take an object
    var talkBtn = button(obj, 'talk', () => {
        console.log('talking to ' + obj.name)
        if (!obj._script) {
            console.warn('obj has no script')
            return
        }
        Scripting.talk(obj._script, obj)
    })
    var pickupBtn = button(obj, 'pickup', () => obj.pickup(globalState.player))

    $menu.appendChild(cancelBtn)
    $menu.appendChild(lookBtn)
    if (obj._script && obj._script.talk_p_proc !== undefined) $menu.appendChild(talkBtn)
    if (obj.canUse) $menu.appendChild(useBtn)
    $menu.appendChild(pickupBtn)
}

export function uiStartCombat() {
    // play end container animation
    Object.assign($id('endContainer').style, { animationPlayState: 'running', webkitAnimationPlayState: 'running' })
}

export function uiEndCombat() {
    // play end container animation
    Object.assign($id('endContainer').style, { animationPlayState: 'running', webkitAnimationPlayState: 'running' })

    // disable buttons
    hidev($id('endTurnButton'))
    hidev($id('endCombatButton'))
}

function uiEndCombatAnimationDone(this: HTMLElement) {
    Object.assign(this.style, { animationPlayState: 'paused', webkitAnimationPlayState: 'paused' })

    if (globalState.inCombat) {
        // enable buttons
        showv($id('endTurnButton'))
        showv($id('endCombatButton'))
    }
}

function uiDrawWeapon() {
    // draw the active weapon in the interface bar
    var weapon = globalState.player.equippedWeapon
    clearEl($id('attackButton'))
    if (!weapon || !weapon.weapon) return

    if (weapon.weapon.type !== 'melee') {
        const $attackButtonWeapon = $id('attackButtonWeapon') as HTMLImageElement
        $attackButtonWeapon.onload = null
        $attackButtonWeapon.onload = function (this: HTMLImageElement) {
            if (!this.complete) return
            Object.assign(this.style, {
                position: 'absolute',
                top: '5px',
                left: $id('attackButton').offsetWidth / 2 - this.width / 2 + 'px',
                maxHeight: $id('attackButton').offsetHeight - 10 + 'px',
            })
            this.setAttribute('draggable', 'false')
        }
        $attackButtonWeapon.src = weapon.invArt + '.png'
    }

    // draw weapon AP
    var CHAR_W = 10
    var digit = weapon.weapon.getAPCost(1)
    if (digit === undefined || digit > 9) return // TODO: Weapon AP >9?
    $id('attackButtonAPDigit').style.backgroundPosition = 0 - CHAR_W * digit + 'px'

    // draw weapon type (single, burst, called, punch, ...)
    // TODO: all melee weapons
    var wepTypes: { [wepType: string]: string } = { melee: 'punch', gun: 'single' }
    var type = wepTypes[weapon.weapon.type]
    $img('attackButtonType').src = `art/intrface/${type}.png`

    // hide or show called shot sigil?
    if (weapon.weapon.mode === 'called') show($id('attackButtonCalled'))
    else hide($id('attackButtonCalled'))
}

// TODO: Rewrite this sanely (and not directly modify the player object's properties...)
function uiMoveSlot(data: string, target: string) {
    const playerUnsafe = globalState.player as any
    var obj = null

    if (data[0] === 'i') {
        if (target === 'inventory') return // disallow inventory -> inventory

        var idx = parseInt(data.slice(1))
        console.log('idx: ' + idx)
        obj = globalState.player.inventory[idx]
        globalState.player.inventory.splice(idx, 1) // remove object from inventory
    } else {
        obj = playerUnsafe[data]
        playerUnsafe[data] = null // remove object from slot
    }

    console.log('obj: ' + obj + ' (data: ' + data + ', target: ' + target + ')')

    if (target === 'inventory') globalState.player.inventory.push(obj)
    else {
        if (playerUnsafe[target] !== undefined && playerUnsafe[target] !== null) {
            // perform a swap
            if (data[0] === 'i') globalState.player.inventory.push(playerUnsafe[target]) // inventory -> slot
            else playerUnsafe[data] = playerUnsafe[target] // slot -> slot
        }

        playerUnsafe[target] = obj // move the object over
    }

    uiInventoryScreen()
}

function makeDropTarget($el: HTMLElement, dropCallback: (data: string, e?: DragEvent) => void) {
    $el.ondrop = (e: DragEvent) => {
        var data = e.dataTransfer.getData('text/plain')
        dropCallback(data, e)
        return false
    }
    $el.ondragenter = () => false
    $el.ondragover = () => false
}

function makeDraggable($el: HTMLElement, data: string, endCallback?: () => void) {
    $el.setAttribute('draggable', 'true')
    $el.ondragstart = (e: DragEvent) => {
        e.dataTransfer.setData('text/plain', data)
        console.log('start drag')
    }
    $el.ondragend = (e: DragEvent) => {
        if (e.dataTransfer.dropEffect !== 'none') {
            //$(this).remove()
            endCallback && endCallback()
        }
    }
}

function uiInventoryScreen() {
    globalState.uiMode = UIMode.inventory

    showv($id('inventoryBox'))
    drawInventory($id('inventoryBoxList'), globalState.player.inventory, (obj: Obj, e: MouseEvent) => {
        makeItemContextMenu(e, obj, 'inventory')
    })

    function drawInventory($el: HTMLElement, objects: Obj[], clickCallback?: (item: Obj, e: MouseEvent) => void) {
        clearEl($el)
        clearEl($id('inventoryBoxItem1'))
        clearEl($id('inventoryBoxItem2'))

        for (let i = 0; i < objects.length; i++) {
            const invObj = objects[i]
            // 90x60 // 70x40
            const img = makeEl('img', {
                src: invObj.invArt + '.png',
                attrs: { width: 72, height: 60, title: invObj.name },
                click: clickCallback
                    ? (e: MouseEvent) => {
                          clickCallback(invObj, e)
                      }
                    : undefined,
            })
            $el.appendChild(img)
            $el.insertAdjacentHTML('beforeend', 'x' + invObj.amount)
            makeDraggable(img, 'i' + i, () => {
                uiInventoryScreen()
            })
        }
    }

    function itemAction(obj: Obj, slot: keyof Player, action: 'cancel' | 'use' | 'drop') {
        switch (action) {
            case 'cancel':
                break
            case 'use':
                console.log('using object: ' + obj.art)
                obj.use(globalState.player)
                break
            case 'drop':
                //console.log("todo: drop " + obj.art); break
                console.log('dropping: ' + obj.art + ' with pid ' + obj.pid)
                if (slot !== 'inventory') {
                    // add into inventory to drop
                    console.log('moving into inventory first')
                    globalState.player.inventory.push(obj)
                    // FIXME: this doesn't type check
                    // player[slot] = null
                }

                obj.drop(globalState.player)
                uiInventoryScreen()
                break
        }
    }

    function makeContextButton(obj: Obj, slot: keyof Player, action: 'cancel' | 'use' | 'drop') {
        return makeEl('img', {
            id: 'context_' + action,
            classes: ['itemContextMenuButton'],
            click: () => {
                itemAction(obj, slot, action)
                hidev($id('itemContextMenu'))
            },
        })
    }

    function makeItemContextMenu(e: MouseEvent, obj: Obj, slot: keyof Player) {
        var $menu = $id('itemContextMenu')
        clearEl($menu)
        Object.assign($menu.style, {
            visibility: 'visible',
            left: `${e.clientX}px`,
            top: `${e.clientY}px`,
        })
        var cancelBtn = makeContextButton(obj, slot, 'cancel')
        var useBtn = makeContextButton(obj, slot, 'use')
        var dropBtn = makeContextButton(obj, slot, 'drop')

        $menu.appendChild(cancelBtn)
        if (obj.canUse) $menu.appendChild(useBtn)
        $menu.appendChild(dropBtn)
    }

    function drawSlot(slot: keyof Player, slotID: string) {
        var art = globalState.player[slot].invArt
        // 90x60 // 70x40
        var img = makeEl('img', {
            src: art + '.png',
            attrs: { width: 72, height: 60, title: globalState.player[slot].name },
            click: (e: MouseEvent) => {
                makeItemContextMenu(e, globalState.player[slot], slot)
            },
        })
        makeDraggable(img, slot)

        const $slotEl = $id(slotID)
        clearEl($slotEl)
        $slotEl.appendChild(img)
    }

    if (globalState.player.leftHand) drawSlot('leftHand', 'inventoryBoxItem1')
    if (globalState.player.rightHand) drawSlot('rightHand', 'inventoryBoxItem2')
}

function drawHP(hp: number) {
    drawDigits('#hpDigit', hp, 4, true)
}

function drawDigits(idPrefix: string, amount: number, maxDigits: number, hasSign: boolean) {
    var CHAR_W = 9,
        CHAR_NEG = 12
    var sign = amount < 0 ? CHAR_NEG : 0
    if (amount < 0) amount = -amount
    var digits = amount.toString()
    var firstDigitIdx = hasSign ? 2 : 1
    if (hasSign) $q(idPrefix + '1').style.backgroundPosition = 0 - CHAR_W * sign + 'px' // sign
    for (
        var i = firstDigitIdx;
        i <= maxDigits - digits.length;
        i++ // left-fill with zeroes
    )
        $q(idPrefix + i).style.backgroundPosition = '0px'
    for (var i = 0; i < digits.length; i++) {
        var idx = digits.length - 1 - i
        if (digits[idx] === '-') var digit = 12
        else var digit = parseInt(digits[idx])
        $q(idPrefix + (maxDigits - i)).style.backgroundPosition = 0 - CHAR_W * digit + 'px'
    }
}

// Smoothly transition an element's top property from an origin to a target position over a duration
function uiAnimateBox($el: HTMLElement, origin: number | null, target: number, callback?: () => void): void {
    const style = $el.style

    // Reset to origin, instantly
    if (origin !== null) {
        style.transition = 'none'
        style.top = `${origin}px`
    }

    // We need to wait for the browser to process the updated CSS position, so we need to wait here
    setTimeout(() => {
        // Set up our transition finished callback if necessary
        if (callback) {
            let listener = () => {
                callback()
                $el.removeEventListener('transitionend', listener)
                ;(listener as any) = null // Allow listener to be GC'd
            }

            $el.addEventListener('transitionend', listener)
        }

        // Ease into the target position over 1 second
        $el.style.transition = 'top 1s ease'
        $el.style.top = `${target}px`
    }, 1)
}

export function uiStartDialogue(force: boolean, target?: Critter) {
    if (globalState.uiMode === UIMode.barter && force !== true) return

    globalState.uiMode = UIMode.dialogue
    $id('dialogueContainer').style.visibility = 'visible'
    $id('dialogueBox').style.visibility = 'visible'
    uiAnimateBox($id('dialogueBox'), 480, 290)

    // center around the dialogue target
    if (!target) return
    var bbox = objectBoundingBox(target)
    if (bbox !== null) {
        const dc = $id('dialogueContainer')
        // alternatively: dc.offset().left - $(heart.canvas).offset().left
        const dx = ((dc.offsetWidth / 2) | 0) + dc.offsetLeft
        const dy = ((dc.offsetHeight / 4) | 0) + dc.offsetTop - ((bbox.h / 2) | 0)
        globalState.cameraPosition.x = bbox.x - dx
        globalState.cameraPosition.y = bbox.y - dy
    }
}

export function uiEndDialogue() {
    // TODO: Transition the dialogue box down?
    globalState.uiMode = UIMode.none

    $id('dialogueContainer').style.visibility = 'hidden'
    $id('dialogueBox').style.visibility = 'hidden'
    $id('dialogueBoxReply').innerHTML = ''
}

export function uiSetDialogueReply(reply: string) {
    const $dialogueBoxReply = $id('dialogueBoxReply')
    $dialogueBoxReply.innerHTML = reply
    $dialogueBoxReply.scrollTop = 0

    $id('dialogueBoxTextArea').innerHTML = ''
}

export function uiAddDialogueOption(msg: string, optionID: number) {
    $id('dialogueBoxTextArea').insertAdjacentHTML(
        'beforeend',
        `<li><a href="javascript:dialogueReply(${optionID})">${msg}</a></li>`
    )
}

function uiGetAmount(item: Obj) {
    while (true) {
        var amount: any = prompt('How many?')
        if (amount === null) return 0
        else if (amount === '') return item.amount // all of it!
        else amount = parseInt(amount)

        if (isNaN(amount) || item.amount < amount) alert('Invalid amount')
        else return amount
    }
}

function _uiAddItem(items: Obj[], item: Obj, count: number) {
    for (var i = 0; i < items.length; i++) {
        if (items[i].approxEq(item)) {
            items[i].amount += count
            return
        }
    }

    // no existing item, add new inventory object
    items.push(item.clone().setAmount(count))
}

function uiSwapItem(a: Obj[], item: Obj, b: Obj[], amount: number) {
    // swap item from a -> b
    if (amount === 0) return

    var idx = -1
    for (var i = 0; i < a.length; i++) {
        if (a[i].approxEq(item)) {
            idx = i
            break
        }
    }
    if (idx === -1) throw 'item (' + item + ') does not exist in a'

    if (amount < item.amount)
        // deduct amount from a and give amount to b
        item.amount -= amount
    // just swap them
    else a.splice(idx, 1)

    // add the item to b
    _uiAddItem(b, item, amount)
}

function uiEndBarterMode() {
    const $barterBox = $id('barterBox')

    uiAnimateBox($barterBox, null, 480, () => {
        hidev($id('barterBox'))
        off($id('barterBoxLeft'), 'drop dragenter dragover')
        off($id('barterBoxRight'), 'drop dragenter dragover')
        off($id('barterBoxInventoryLeft'), 'drop dragenter dragover')
        off($id('barterBoxInventoryRight'), 'drop dragenter dragover')
        off($id('barterTalkButton'), 'click')
        off($id('barterOfferButton'), 'click')

        uiStartDialogue(true) // force dialogue mode
    })
}

export function uiBarterMode(merchant: Critter) {
    globalState.uiMode = UIMode.barter

    // Hide dialogue screen for now (animate down)
    const $dialogueBox = $id('dialogueBox')
    uiAnimateBox($dialogueBox, null, 480, () => {
        $dialogueBox.style.visibility = 'hidden'
        console.log('going to pop up barter box')

        // Pop up the bartering screen (animate up)
        const $barterBox = $id('barterBox')
        $barterBox.style.visibility = 'visible'
        uiAnimateBox($barterBox, 480, 290)
    })

    // logic + UI for bartering
    // TODO: would it be better if we dropped the "working" copies?

    // a copy of inventories for both parties
    let workingPlayerInventory = globalState.player.inventory.map(cloneItem)
    let workingMerchantInventory = merchant.inventory.map(cloneItem)

    // and our working barter tables
    let playerBarterTable: Obj[] = []
    let merchantBarterTable: Obj[] = []

    function totalAmount(objects: Obj[]): number {
        var total = 0
        for (var i = 0; i < objects.length; i++) {
            total += objects[i].pro.extra.cost * objects[i].amount
        }
        return total
    }

    // TODO: checkOffer() or some-such
    function offer() {
        console.log('[OFFER]')

        var merchantOffered = totalAmount(merchantBarterTable)
        var playerOffered = totalAmount(playerBarterTable)
        var diffOffered = playerOffered - merchantOffered

        if (diffOffered >= 0) {
            // OK, player offered equal to more more than the value
            console.log('[OFFER OK]')

            // finalize and apply the deal

            // swap to working inventories
            merchant.inventory = workingMerchantInventory
            globalState.player.inventory = workingPlayerInventory

            // add in the table items
            for (var i = 0; i < merchantBarterTable.length; i++)
                globalState.player.addInventoryItem(merchantBarterTable[i], merchantBarterTable[i].amount)
            for (var i = 0; i < playerBarterTable.length; i++)
                merchant.addInventoryItem(playerBarterTable[i], playerBarterTable[i].amount)

            // re-clone so we can continue bartering if necessary
            workingPlayerInventory = globalState.player.inventory.map(cloneItem)
            workingMerchantInventory = merchant.inventory.map(cloneItem)

            playerBarterTable = []
            merchantBarterTable = []

            redrawBarterInventory()
        } else {
            console.log('[OFFER REFUSED]')
        }
    }

    function drawInventory($el: HTMLElement, who: 'p' | 'm' | 'l' | 'r', objects: Obj[]) {
        clearEl($el)

        for (var i = 0; i < objects.length; i++) {
            var inventoryImage = objects[i].invArt
            // 90x60 // 70x40
            var img = makeEl('img', {
                src: inventoryImage + '.png',
                attrs: { width: 72, height: 60, title: objects[i].name },
            })
            $el.appendChild(img)
            $el.insertAdjacentHTML('beforeend', 'x' + objects[i].amount)
            makeDraggable(img, who + i)
        }
    }

    function uiBarterMove(data: string, where: 'left' | 'right' | 'leftInv' | 'rightInv') {
        console.log('barter: move ' + data + ' to ' + where)

        var from = (
            {
                p: workingPlayerInventory,
                m: workingMerchantInventory,
                l: playerBarterTable,
                r: merchantBarterTable,
            } as any
        )[data[0]]

        if (from === undefined) throw 'uiBarterMove: wrong data: ' + data

        var idx = parseInt(data.slice(1))
        var obj = from[idx]
        if (obj === undefined) throw 'uiBarterMove: obj not found in list (' + idx + ')'

        // player inventory -> left table or player inventory
        if (data[0] === 'p' && where !== 'left' && where !== 'leftInv') return

        // merchant inventory -> right table or merchant inventory
        if (data[0] === 'm' && where !== 'right' && where !== 'rightInv') return

        var to = {
            left: playerBarterTable,
            right: merchantBarterTable,
            leftInv: workingPlayerInventory,
            rightInv: workingMerchantInventory,
        }[where]

        if (to === undefined) throw 'uiBarterMove: invalid location: ' + where
        else if (to === from)
            // table -> same table
            return
        else if (obj.amount > 1) uiSwapItem(from, obj, to, uiGetAmount(obj))
        else uiSwapItem(from, obj, to, 1)

        redrawBarterInventory()
    }

    // bartering drop targets
    makeDropTarget($id('barterBoxLeft'), (data: string) => {
        uiBarterMove(data, 'left')
    })
    makeDropTarget($id('barterBoxRight'), (data: string) => {
        uiBarterMove(data, 'right')
    })
    makeDropTarget($id('barterBoxInventoryLeft'), (data: string) => {
        uiBarterMove(data, 'leftInv')
    })
    makeDropTarget($id('barterBoxInventoryRight'), (data: string) => {
        uiBarterMove(data, 'rightInv')
    })

    $id('barterTalkButton').onclick = uiEndBarterMode
    $id('barterOfferButton').onclick = offer

    function redrawBarterInventory() {
        drawInventory($id('barterBoxInventoryLeft'), 'p', workingPlayerInventory)
        drawInventory($id('barterBoxInventoryRight'), 'm', workingMerchantInventory)
        drawInventory($id('barterBoxLeft'), 'l', playerBarterTable)
        drawInventory($id('barterBoxRight'), 'r', merchantBarterTable)

        var moneyLeft = totalAmount(playerBarterTable)
        var moneyRight = totalAmount(merchantBarterTable)

        $id('barterBoxLeftAmount').innerHTML = '$' + moneyLeft
        $id('barterBoxRightAmount').innerHTML = '$' + moneyRight
    }

    redrawBarterInventory()
}

function uiEndLoot() {
    globalState.uiMode = UIMode.none

    hidev($id('lootBox'))
    off($id('lootBoxLeft'), 'drop dragenter dragover')
    off($id('lootBoxRight'), 'drop dragenter dragover')
    off($id('lootBoxTakeAllButton'), 'click')
}

export function uiLoot(object: Obj) {
    globalState.uiMode = UIMode.loot

    function uiLootMove(data: string /* "l"|"r" */, where: 'left' | 'right') {
        console.log('loot: move ' + data + ' to ' + where)

        var from = ({ l: globalState.player.inventory, r: object.inventory } as any)[data[0]]

        if (from === undefined) throw 'uiLootMove: wrong data: ' + data

        var idx = parseInt(data.slice(1))
        var obj = from[idx]
        if (obj === undefined) throw 'uiLootMove: obj not found in list (' + idx + ')'

        var to = { left: globalState.player.inventory, right: object.inventory }[where]

        if (to === undefined) throw 'uiLootMove: invalid location: ' + where
        else if (to === from)
            // object -> same location
            return
        else if (obj.amount > 1) uiSwapItem(from, obj, to, uiGetAmount(obj))
        else uiSwapItem(from, obj, to, 1)

        drawLoot()
    }

    function drawInventory($el: HTMLElement, who: 'p' | 'm' | 'l' | 'r', objects: Obj[]) {
        clearEl($el)

        for (var i = 0; i < objects.length; i++) {
            var inventoryImage = objects[i].invArt
            // 90x60 // 70x40
            var img = makeEl('img', {
                src: inventoryImage + '.png',
                attrs: { width: 72, height: 60, title: objects[i].name },
            })
            $el.appendChild(img)
            $el.insertAdjacentHTML('beforeend', 'x' + objects[i].amount)
            makeDraggable(img, who + i)
        }
    }

    console.log('looting...')

    showv($id('lootBox'))

    // loot drop targets
    makeDropTarget($id('lootBoxLeft'), (data: string) => {
        uiLootMove(data, 'left')
    })
    makeDropTarget($id('lootBoxRight'), (data: string) => {
        uiLootMove(data, 'right')
    })

    $id('lootBoxTakeAllButton').onclick = () => {
        console.log('take all...')
        var inv = object.inventory.slice(0) // clone inventory
        for (var i = 0; i < inv.length; i++)
            uiSwapItem(object.inventory, inv[i], globalState.player.inventory, inv[i].amount)
        drawLoot()
    }

    function drawLoot() {
        drawInventory($id('lootBoxLeft'), 'l', globalState.player.inventory)
        drawInventory($id('lootBoxRight'), 'r', object.inventory)
    }

    drawLoot()
}

export function uiLog(msg: string) {
    const $log = $id('displayLog')
    $log.insertAdjacentHTML('beforeend', `<li>${msg}</li>`)
    $log.scrollTop = $log.scrollHeight
}

export function uiCloseWorldMap() {
    globalState.uiMode = UIMode.none

    hide($id('worldMapContainer'))
    hidev($id('areamap'))
    hidev($id('worldmap'))

    Worldmap.stop()
}

export function uiWorldMap(onAreaMap: boolean = false) {
    globalState.uiMode = UIMode.worldMap
    show($id('worldMapContainer'))

    if (!globalState.mapAreas) globalState.mapAreas = loadAreas()

    if (onAreaMap) uiWorldMapAreaView()
    else uiWorldMapWorldView()
    uiWorldMapLabels()
}

function uiWorldMapAreaView() {
    hidev($id('worldmap'))
    showv($id('areamap'))

    Worldmap.stop()
}

function uiWorldMapWorldView() {
    showv($id('worldmap'))
    hidev($id('areamap'))

    Worldmap.start()
}

export function uiWorldMapShowArea(area: Area) {
    uiWorldMapAreaView()

    const $areamap = $id('areamap')
    $areamap.style.backgroundImage = `url('${area.mapArt}.png')`
    clearEl($areamap)

    for (const entrance of area.entrances) {
        console.log('Area entrance: ' + entrance.mapLookupName)
        var $entranceEl = makeEl('div', { classes: ['worldmapEntrance'] })
        var $hotspot = makeEl('div', { classes: ['worldmapEntranceHotspot'] })

        $hotspot.onclick = () => {
            // hotspot click -- travel to relevant map
            const mapName = lookupMapNameFromLookup(entrance.mapLookupName)
            console.log('hotspot -> ' + mapName + ' (via ' + entrance.mapLookupName + ')')
            globalState.gMap.loadMap(mapName)
            uiCloseWorldMap()
        }

        $entranceEl.appendChild($hotspot)
        appendHTML($entranceEl, entrance.mapLookupName)
        $entranceEl.style.left = entrance.x + 'px'
        $entranceEl.style.top = entrance.y + 'px'
        $id('areamap').appendChild($entranceEl)
    }
}

function uiWorldMapLabels() {
    $id('worldMapLabels').innerHTML = "<div id='worldMapLabelsBackground'></div>"

    var i = 0
    for (const areaID in globalState.mapAreas) {
        var area = globalState.mapAreas[areaID]
        if (!area.labelArt) continue

        var label = makeEl('img', { classes: ['worldMapLabelImage'], src: area.labelArt + '.png' })
        var labelButton = makeEl('div', {
            classes: ['worldMapLabelButton'],
            click: () => {
                uiWorldMapShowArea(globalState.mapAreas[areaID])
            },
        })

        var areaLabel = makeEl('div', {
            classes: ['worldMapLabel'],
            style: { top: 1 + i * 27 + 'px' },
            children: [label, labelButton],
        })
        $id('worldMapLabels').appendChild(areaLabel)
        i++
    }
}

function uiElevatorDone() {
    globalState.uiMode = UIMode.none
    hidev($id('elevatorBox'))

    // flip all buttons to hidden
    for (const $elevatorButton of $qa('.elevatorButton')) {
        hidev($elevatorButton)
        $elevatorButton.onclick = null
    }
    hidev($id('elevatorLabel'))
}

export function uiElevator(elevator: Elevator) {
    globalState.uiMode = UIMode.elevator
    var art = lookupInterfaceArt(elevator.type)
    console.log('elevator art: ' + art)
    console.log('buttons: ' + elevator.buttonCount)

    if (elevator.labels !== -1) {
        var labelArt = lookupInterfaceArt(elevator.labels)
        console.log('elevator label art: ' + labelArt)

        const $elevatorLabel = $id('elevatorLabel')
        showv($elevatorLabel)
        $elevatorLabel.style.backgroundImage = `url('${labelArt}.png')`
    }

    const $elevatorBox = $id('elevatorBox')
    showv($elevatorBox)
    $elevatorBox.style.backgroundImage = `url('${art}.png')`

    // flip the buttons we need visible
    for (let i = 1; i <= elevator.buttonCount; i++) {
        const $elevatorButton = $id('elevatorButton' + i)
        showv($elevatorButton)
        $elevatorButton.onclick = () => {
            // button `i` pushed
            // todo: animate positioner/spinner (and come up with a better name for that)

            var mapID = elevator.buttons[i - 1].mapID
            var level = elevator.buttons[i - 1].level
            var position = fromTileNum(elevator.buttons[i - 1].tileNum)

            if (mapID !== globalState.gMap.mapID) {
                // different map
                console.log('elevator -> map ' + mapID + ', level ' + level + ' @ ' + position.x + ', ' + position.y)
                globalState.gMap.loadMapByID(mapID, position, level)
            } else if (level !== globalState.currentElevation) {
                // same map, different elevation
                console.log('elevator -> level ' + level + ' @ ' + position.x + ', ' + position.y)
                globalState.player.move(position)
                globalState.gMap.changeElevation(level, true)
            }

            // else, same elevation, do nothing
            uiElevatorDone()
        }
    }
}

export function uiCloseCalledShot() {
    globalState.uiMode = UIMode.none
    hide($id('calledShotBox'))
}

export function uiCalledShot(art: string, target: Critter, callback?: (regionHit: string) => void) {
    globalState.uiMode = UIMode.calledShot
    show($id('calledShotBox'))

    function drawChance(region: string) {
        var chance: any = Combat.prototype.getHitChance(globalState.player, target, region).hit
        console.log('id: %s | chance: %d', '#calledShot-' + region + '-chance #digit', chance)
        if (chance <= 0) chance = '--'
        drawDigits('#calledShot-' + region + '-chance #digit', chance, 2, false)
    }

    drawChance('torso')
    drawChance('head')
    drawChance('eyes')
    drawChance('groin')
    drawChance('leftArm')
    drawChance('rightArm')
    drawChance('leftLeg')
    drawChance('rightLeg')

    $id('calledShotBackground').style.backgroundImage = `url('${art}.png')`

    for (const $label of $qa('.calledShotLabel')) {
        $label.onclick = (evt: MouseEvent) => {
            var id = (evt.target as HTMLElement).id
            var regionHit = id.split('-')[1]
            console.log('clicked a called location (%s)', regionHit)
            if (callback) callback(regionHit)
        }
    }
}

export function uiSaveLoad(isSave: boolean): void {
    globalState.uiMode = UIMode.saveLoad

    const saveList = new Ui.List({ x: 55, y: 50, w: 'auto', h: 'auto' })
    const saveInfo = new Ui.Label(404, 262, '', '#00FF00')
    // TODO: CSSBoundingBox's width and height should be optional (and default to `auto`), then Label can accept one
    Object.assign(saveInfo.elem.style, {
        width: '154px',
        height: '33px',
        fontSize: '8pt',
        overflow: 'hidden',
    })

    const saveLoadWindow = new Ui.WindowFrame('art/intrface/lsgame.png', { x: 80, y: 20, w: 640, h: 480 })
        .add(new Ui.Widget('art/intrface/lscover.png', { x: 340, y: 40, w: 275, h: 173 }))
        .add(new Ui.Label(50, 26, isSave ? 'Save Game' : 'Load Game'))
        .add(new Ui.SmallButton(391, 349).onClick(selected))
        .add(new Ui.Label(391 + 18, 349, 'Done'))
        .add(new Ui.SmallButton(495, 349).onClick(done))
        .add(new Ui.Label(495 + 18, 349, 'Cancel'))
        .add(saveInfo)
        .add(saveList)
        .show()

    if (isSave) {
        saveList.select(
            saveList.addItem({
                text: '<New Slot>',
                id: -1,
                onSelected: () => {
                    saveInfo.setText('New save')
                },
            })
        )
    }

    // List saves, and write them to the UI list
    SaveLoad.saveList((saves: SaveLoad.SaveGame[]) => {
        for (const save of saves) {
            saveList.addItem({
                text: save.name,
                id: save.id,
                onSelected: () => {
                    saveInfo.setText(SaveLoad.formatSaveDate(save) + '<br>' + save.currentMap)
                },
            })
        }
    })

    function done() {
        globalState.uiMode = UIMode.none
        saveLoadWindow.close()
    }

    function selected() {
        // Done was clicked, so save/load the slot
        const item = saveList.getSelection()
        if (!item) return // No slot selected

        const saveID = item.id

        console.log('[UI] %s save #%d.', isSave ? 'Saving' : 'Loading', saveID)

        if (isSave) {
            const name = prompt('Save Name?')

            if (saveID !== -1) {
                if (!confirm('Are you sure you want to overwrite that save slot?')) return
            }

            SaveLoad.save(name, saveID === -1 ? undefined : saveID, done)
        } else {
            SaveLoad.load(saveID)
            done()
        }
    }
}
