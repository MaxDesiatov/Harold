/*
Copyright 2014-2017 darkf

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

import { getFileJSON, getFileText, parseIni } from './util.js'
import globalState from './globalState.js'
import { Point } from './geometry.js'
import { lookupInterfaceArt } from './pro.js'

var lstFiles: { [lsgFile: string]: string[] } = {}
var mapInfo: { [mapID: number]: MapInfo } | null = null
var elevatorInfo: { elevators: Elevator[] } | null = null

export interface AreaMap {
    // XXX: Why does using a number key break areas?
    [areaID: string]: Area
}

export interface Area {
    name: string
    id: number
    size: string
    state: boolean
    worldPosition: Point
    mapArt?: string
    labelArt?: string
    entrances: AreaEntrance[]
}

interface AreaEntrance {
    startState: string
    x: number
    y: number
    mapLookupName: string
    mapName: string
    elevation: number
    tileNum: number
    orientation: number
}

export interface MapInfo {
    name: string
    lookupName: string
    ambientSfx: [string, number][]
    music: string
    randomStartPoints: { elevation: number; tileNum: number }[]
}

export interface Elevator {
    buttons: { tileNum: number; mapID: number; level: number }[]
    buttonCount: number
    labels: number
    type: number
}

export function getElevator(type: number): Elevator {
    if (!elevatorInfo) {
        console.log('loading elevator info')
        elevatorInfo = getFileJSON('lut/elevators.json')
    }

    return elevatorInfo!.elevators[type]
}

function parseAreas(data: string): AreaMap {
    var areas = parseIni(data)
    var out: AreaMap = {}

    for (var _area in areas) {
        var area = areas[_area]
        var match = _area.match(/Area (\d+)/)
        if (match === null) throw 'city.txt: invalid area name: ' + area.area_name
        var areaID = parseInt(match[1])
        var worldPos = area.world_pos.split(',').map((x: string) => parseInt(x))

        var newArea: Area = {
            name: area.area_name,
            id: areaID,
            size: area.size.toLowerCase(),
            state: area.start_state.toLowerCase() === 'on',
            worldPosition: { x: worldPos[0], y: worldPos[1] },
            entrances: [],
        }

        // map/label art
        var mapArtIdx = parseInt(area.townmap_art_idx)
        var labelArtIdx = parseInt(area.townmap_label_art_idx)

        //console.log(mapArtIdx + " - " + labelArtIdx)

        if (mapArtIdx !== -1) newArea.mapArt = lookupInterfaceArt(mapArtIdx)
        if (labelArtIdx !== -1) newArea.labelArt = lookupInterfaceArt(labelArtIdx)

        // entrances
        for (const _key in area) {
            // entrance_N
            // e.g.: entrance_0=On,345,230,Destroyed Arroyo Bridge,-1,26719,0

            let s = _key.split('_')
            if (s[0] === 'entrance') {
                const entranceString = area[_key]
                s = entranceString.split(',')

                const mapLookupName = s[3].trim()
                const mapName = lookupMapNameFromLookup(mapLookupName)
                if (!mapName) throw Error("Couldn't look up map name")

                const entrance = {
                    startState: s[0],
                    x: parseInt(s[1]),
                    y: parseInt(s[2]),
                    mapLookupName,
                    mapName,
                    elevation: parseInt(s[4]),
                    tileNum: parseInt(s[5]),
                    orientation: parseInt(s[6]),
                }
                newArea.entrances.push(entrance)
            }
        }

        out[areaID] = newArea
    }

    return out
}

function areaContainingMap(mapName: string) {
    if (!globalState.mapAreas) throw Error('globalState.mapAreas not loaded')
    for (var area in globalState.mapAreas) {
        var entrances = globalState.mapAreas[area].entrances
        for (var i = 0; i < entrances.length; i++) {
            if (entrances[i].mapName === mapName) return globalState.mapAreas[area]
        }
    }
    return null
}

export function loadAreas() {
    return parseAreas(getFileText('data/data/city.txt'))
}

function allAreas() {
    if (globalState.mapAreas === null) globalState.mapAreas = loadAreas()
    var areas = []
    for (var area in globalState.mapAreas) areas.push(globalState.mapAreas[area])
    return areas
}

export function loadMessage(name: string) {
    name = name.toLowerCase()
    var msg = getFileText('data/text/english/game/' + name + '.msg')
    if (globalState.messageFiles[name] === undefined) globalState.messageFiles[name] = {}

    // parse message file
    var lines = msg.split(/\r|\n/)

    // preprocess and merge lines
    for (var i = 0; i < lines.length; i++) {
        // comments/blanks
        if (lines[i][0] === '#' || lines[i].trim() === '') {
            lines.splice(i--, 1)
            continue
        }

        // probably a continuation -- merge it with the last line
        if (lines[i][0] !== '{') {
            lines[i - 1] += lines[i]
            lines.splice(i--, 1)
            continue
        }
    }

    for (var i = 0; i < lines.length; i++) {
        // e.g. {100}{}{You have entered a dark cave in the side of a mountain.}
        var m = lines[i].match(/\{(\d+)\}\{.*\}\{(.*)\}/)
        if (m === null) throw 'message parsing: not a valid line: ' + lines[i]
        // HACK: replace unicode replacement character with an apostrophe (because the Web sucks at character encodings)
        globalState.messageFiles[name][m[1]] = m[2].replace(/\ufffd/g, "'")
    }
}

function loadLst(lst: string): string[] {
    return getFileText('data/' + lst + '.lst').split('\n')
}

export function getLstId(lst: string, id: number): string | null {
    if (lstFiles[lst] === undefined) lstFiles[lst] = loadLst(lst)
    if (lstFiles[lst] === undefined) return null

    return lstFiles[lst][id]
}

export function lookupScriptName(scriptID: number): string {
    console.log('SID: ' + scriptID)
    const lookupName = getLstId('scripts/scripts', scriptID - 1)
    if (lookupName === null) throw Error('lookupScriptName: failed to look up script name')
    return lookupName.split('.')[0].toLowerCase()
}

// Map info (data/data/maps.txt)

function parseMapInfo() {
    if (mapInfo !== null) return

    // parse map info from data/data/maps.txt
    mapInfo = {}
    const text = getFileText('data/data/maps.txt')
    const ini = parseIni(text)
    for (var category in ini) {
        const m = category.match(/Map (\d+)/)
        if (!m) throw Error('maps.txt: invalid category: ' + category)

        let id: string | number = m[1]
        if (id === null) throw 'maps.txt: invalid category: ' + category
        id = parseInt(id)

        var randomStartPoints = []
        for (var key in ini[category]) {
            if (key.indexOf('random_start_point_') === 0) {
                var startPoint = ini[category][key].match(/elev:(\d), tile_num:(\d+)/)
                if (startPoint === null) throw 'invalid random_start_point: ' + ini[category][key]
                randomStartPoints.push({ elevation: parseInt(startPoint[1]), tileNum: parseInt(startPoint[2]) })
            }
        }

        // parse ambient sfx list
        var ambientSfx: [string, number][] = []
        var ambient_sfx = ini[category].ambient_sfx
        if (ambient_sfx) {
            var s = ambient_sfx.split(',')
            for (var i = 0; i < s.length; i++) {
                var kv = s[i].trim().split(':')
                ambientSfx.push([kv[0].toLowerCase(), parseInt(kv[1].toLowerCase())])
            }
        }

        mapInfo[id] = {
            name: ini[category].map_name,
            lookupName: ini[category].lookup_name,
            ambientSfx: ambientSfx,
            music: (ini[category].music || '').trim().toLowerCase(),
            randomStartPoints: randomStartPoints,
        }
    }
}

export function lookupMapFromLookup(lookupName: string) {
    if (mapInfo === null) parseMapInfo()

    for (var mapID in mapInfo!) {
        if (mapInfo![mapID].lookupName === lookupName) return mapInfo![mapID]
    }
    return null
}

export function lookupMapNameFromLookup(lookupName: string) {
    if (mapInfo === null) parseMapInfo()

    for (var mapID in mapInfo!) {
        if (mapInfo![mapID].lookupName.toLowerCase() === lookupName.toLowerCase()) return mapInfo![mapID].name
    }
    return null
}

export function lookupMapName(mapID: number): string | null {
    if (mapInfo === null) parseMapInfo()

    return mapInfo![mapID].name || null
}

function getMapInfo(mapName: string) {
    if (mapInfo === null) parseMapInfo()

    for (var mapID in mapInfo!) {
        if (mapInfo![mapID].name.toLowerCase() === mapName.toLowerCase()) return mapInfo![mapID]
    }
    return null
}

export function getCurrentMapInfo() {
    return getMapInfo(globalState.gMap.name)
}
