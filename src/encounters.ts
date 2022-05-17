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

import { lookupMapNameFromLookup, MapInfo } from "./data.js";
import { hexInDirectionDistance, Point } from "./geometry.js";
import globalState from "./globalState.js";
import { Scripting } from "./scripting.js";
import { fromTileNum } from "./tile.js";
import { getRandomInt } from "./util.js";
import { Worldmap } from "./worldmap.js";

// Random Encounter system

export module Encounters {
    enum Tok {
        IF = 0,
        LPAREN = 1,
        RPAREN = 2,
        IDENT = 3,
        OP = 4,
        INT = 5
    }
        
    type Token = [Tok, string /* Matched text */, number /* length (or number value for Tok.INT tokens) */];
    
    interface IfNode { type: "if", cond: Node }
    interface OpNode { type: "op", op: string, lhs: Node, rhs: Node }
    interface CallNode { type: "call", name: string, arg: Node }
    interface VarNode { type: "var", name: string }
    interface IntNode { type: "int", value: number }
    
    export type Node = IfNode | OpNode | CallNode | VarNode | IntNode;

    function tokenizeCond(data: string): Token[] {
        var tokensRe: { [re: string]: number } = {
            "if": Tok.IF,
            "and": Tok.OP,
            "[a-z_]+": Tok.IDENT,
            "-?[0-9]+": Tok.INT,
            "[><=&]+": Tok.OP,
            "\\(": Tok.LPAREN,
            "\\)": Tok.RPAREN,
        }

        function match(str: string): Token|null {
            for(var re in tokensRe) {
                var m = str.match(new RegExp("^\\s*(" + re + ")\\s*"))
                if(m !== null)
                    return [tokensRe[re], m[1], m[0].length]
            }
            return null
        }

        var acc = data
        var toks: Token[] = []
        while(acc.length > 0) {
            var m = match(acc)
            if(m === null)
                throw "error parsing condition: '" + data + "': choked on '" + acc + "'"
            toks.push(m[0] === Tok.INT ? [Tok.INT, m[1], parseInt(m[1])] : m)
            acc = acc.slice(m[2])
        }

        return toks
    }

    function parseCond(data: string) {
        data = data.replace("%", "") // percentages don't really matter
        var tokens = tokenizeCond(data)
        var curTok = 0

        function expect(t: Tok) {
            if(tokens[curTok++][0] !== t)
                throw "expect: expected " + t + ", got " + tokens[curTok-1] +
                      ", input: " + data
        }

        function next() {
            return tokens[curTok++]
        }

        function peek() {
            if(curTok >= tokens.length)
                return null
            return tokens[curTok]
        }

        function call(name: string): Node {
            expect(Tok.LPAREN)
            var arg = expr()
            expect(Tok.RPAREN)
            return {type: 'call', name, arg}
        }

        function checkOp(node: Node): Node {
            var t = peek()
            if(t === null || t[0] !== Tok.OP)
                return node

            curTok++
            var rhs = checkOp(expr())
            return {type: 'op', op: t[1], lhs: node, rhs: rhs}
        }

        function expr(): Node {
            var t = next()
            switch(t[0]) {
                case Tok.IF:
                    expect(Tok.LPAREN)
                    var cond = expr()
                    expect(Tok.RPAREN)
                    return checkOp({type: 'if', cond: cond})
                case Tok.IDENT:
                    if(peek()![0] === Tok.LPAREN)
                        return checkOp(call(t[1]))
                    return checkOp({type: 'var', name: t[1]})
                case Tok.INT:
                    return checkOp({type: 'int', value: t[2]})
                default:
                    throw "unhandled/unexpected token: " + t + " in: " + data
            }
        }

        return expr()
    }

    export function parseConds(data: string) {
        // conditions are formed by conjunctions, so
        // x AND y AND z can just be collapsed to [x, y, z] here

        var cond = parseCond(data)
        var out: Node[] = []

        function visit(node: Node) {
            if(node.type === "op" && node.op === "and") {
                visit(node.lhs)
                visit(node.rhs)
            }
            else
                out.push(node)
        }

        visit(cond)
        return out
    }

    function printTree(node: Node, s: string) {
        switch(node.type) {
            case "if":
                console.log(s + "if")
                printTree(node.cond, s + "  ")
                break
            case "op":
                console.log(s + "op " + node.op + "")
                printTree(node.lhs, s + "  ")
                printTree(node.rhs, s + "  ")
                break
            case "call":
                console.log(s + "call " + node.name + "")
                printTree(node.arg, s + "  ")
                break
            case "var":
                console.log(s + "var " + node.name)
                break
            case "int":
                console.log(s + "int " + node.value)
                break
        }
    }

    // evaluates conditions against game state
    function evalCond(node: Node): number|boolean {
        switch(node.type) {
            case "if": // condition
                return evalCond(node.cond)
            case "call": // call (more like a property access)
                switch(node.name) {
                    case "global": // GVAR
                        if(node.arg.type !== "int") throw "evalCond: GVAR not a number";
                        return Scripting.getGlobalVar(node.arg.value)
                    case "player":
                        if(node.arg.type !== "var") throw "evalCond: player arg not a var";
                        if(node.arg.name !== "level")
                            throw "player( " + node.arg.name + ")"
                        return 0 // player level
                    case "rand": // random percentage
                        if(node.arg.type !== "int") throw "evalCond: rand arg not a number";
                        return getRandomInt(0, 100) <= node.arg.value
                    default: throw "unhandled call: " + node.name
                }
            case "var":
                switch(node.name) {
                    case "time_of_day":
                        return 12 // hour of the day
                    default: throw "unhandled var: " + node.name
                }
            case "int": return node.value
            case "op":
                var lhs = evalCond(node.lhs)
                var rhs = evalCond(node.rhs)
                var op: { [op: string]: (l: boolean|number, r: boolean|number) => boolean|number } =  {
                    "<": (l, r) => l < r,
                    ">": (l, r) => l > r,
                    "and": (l, r) => l && r
                }

                if(op[node.op] === undefined)
                    throw "unhandled op: " + node.op
                return op[node.op](lhs, rhs)
            default: throw "unhandled node: " + node
        }
    }

    function evalConds(conds: Node[]): boolean {
        // TODO: Array.every
        for(var i = 0; i < conds.length; i++) {
            if(evalCond(conds[i]) === false)
                return false
        }
        return true
    }

    function evalEncounterCritter(critter: Worldmap.EncounterCritter): Worldmap.EncounterCritter {
        var items = []
        for(var i = 0; i < critter.items.length; i++) {
            var item = critter.items[i]
            var amount = 1

            if(item.range) {
                amount = getRandomInt(item.range.start, item.range.end)
            }

            if(amount > 0)
                items.push({pid: item.pid, wielded: item.wielded, amount: amount})
        }

        return {items: items, pid: critter.pid, script: critter.script, dead: critter.dead}
    }

    function evalEncounterCritters(count: number, group: Worldmap.EncounterGroup): Worldmap.EncounterCritter[] {
        var critters: Worldmap.EncounterCritter[] = []

        for(var i = 0; i < group.critters.length; i++) {
            var critter = group.critters[i]

            if(critter.cond) {
                if(!evalConds(critter.cond)) {
                    console.log("critter cond false: %o", critter.cond)
                    continue
                }
                else
                    console.log("critter cond true: %o", critter.cond)
            }

            if(critter.ratio === undefined)
                critters.push(evalEncounterCritter(critter))
            else {
                var num = Math.ceil(critter.ratio/100 * count)
                // TODO: better distribution (might be +1 now)
                console.log("critter nums: %d (%d% of %d)", num, critter.ratio, count)
                for(var j = 0; j < num; j++)
                    critters.push(evalEncounterCritter(critter))
            }
        }

        return critters
    }

    function pickEncounter(encounters: Worldmap.Encounter[]) {
        // Pick an encounter from an encounter list based on a roll

        var succEncounters = encounters.filter(function(enc) {
            return (enc.cond !== null) ? evalConds(enc.cond) : true
        })
        var numEncounters = succEncounters.length
        var totalChance = succEncounters.reduce(function(sum, x) { return x.chance + sum }, 0)

        if(numEncounters === 0)
            throw "pickEncounter: There were no successfully-conditioned encounters"

        console.log("pickEncounter: num: %d, chance: %d, encounters: %o", numEncounters, totalChance, succEncounters)

        var luck = globalState.player.getStat("LUK")
        var roll = getRandomInt(0, totalChance) + (luck - 5)

        // TODO: Adjust roll for difficulty (easy +5, hard -5),
        // perks (Scout +1, Ranger +1, Explorer +2)

        // Remove chances from roll until either we reach the end of the list or the roll runs out.
        // If our roll does *not* run out (i.e., its value exceeds totalChance), then
        // we will choose the last encounter in the list.

        var acc = roll
        var idx = 0
        for(; idx < succEncounters.length; idx++) {
            var chance = succEncounters[idx].chance
            if(acc < chance)
                break

            acc -= chance
        }

        console.log("idx: %d", idx)
        return succEncounters[idx]
    }

    export function positionCritters(groups: Worldmap.EncounterGroup[], playerPos: Point, map: MapInfo) {
        // set up critters' positions in their formations

        groups.forEach(function(group) {
            var dir = getRandomInt(0, 5)
            var formation = group.position.type
            let pos: Point

            if(formation === "surrounding")
                pos = {x: playerPos.x, y: playerPos.y}
            else {
                // choose a random starting point from the map
                var randomPoint = map.randomStartPoints[getRandomInt(0, map.randomStartPoints.length - 1)]
                pos = fromTileNum(randomPoint.tileNum)
            }

            console.log("positionCritters: map %o, dir %d, formation %s, pos %o", map, dir, formation, pos)

            group.critters.forEach(function(critter) {
                switch(formation) {
                    case "huddle":
                        critter.position = {x: pos.x, y: pos.y}

                        dir = (dir + 1) % 6
                        pos = hexInDirectionDistance(pos, dir, group.position.spacing)
                        break
                    case "surrounding":
                        var roll = globalState.player.getStat("PER") + getRandomInt(-2, 2)
                        // TODO: if have Cautious Nature perk, roll += 3

                        if(roll < 0)
                            roll = 0

                        pos = hexInDirectionDistance(pos, dir, roll)

                        dir++
                        if(dir >= 6)
                            dir = 0

                        var rndSpacing = getRandomInt(0, Math.floor(roll / 2))
                        var rndDir = getRandomInt(0, 5)
                        pos = hexInDirectionDistance(pos, (rndDir + dir) % 6, rndSpacing)

                        critter.position = {x: pos.x, y: pos.y}
                        break

                    case "straight_line":
                    case "double_line":
                    case "wedge":
                    case "cone":
                    default:
                        console.log("UNHANDLED FORMATION %s", formation)

                        // use some arbitrary formation
                        critter.position = {x: pos.x, y: pos.y}
                        pos.x--
                        
                        break
                }
            })
        })
    }

    export function evalEncounter(encTable: Worldmap.EncounterTable) {
        var mapIndex = getRandomInt(0, encTable.maps.length - 1)
        var mapLookupName = encTable.maps[mapIndex]
        var mapName = lookupMapNameFromLookup(mapLookupName)
        var groups: Worldmap.EncounterGroup[] = []
        var encounter = pickEncounter(encTable.encounters)

        if(encounter.special !== null) {
            // special encounter: use specific map
            mapLookupName = encounter.special
            mapName = lookupMapNameFromLookup(mapLookupName)
            console.log("special encounter: %s", mapName)
        }

        console.log("map: %s (from %s)", mapName, mapLookupName)
        console.log("encounter: %o", encounter)

        // TODO: maybe unify these and just have a `.groups` in the encounter, along with a target.
        if(encounter.enc.type === "ambush") {
            // player ambush
            console.log("(player ambush)")

            var party = encounter.enc.party
            var group = Worldmap.getEncounterGroup(party.name)
            var position = group.position

            console.log("party: %d-%d of %s", party.start, party.end, party.name)
            console.log("encounter group: %o", group)
            console.log("position:", position)

            var critterCount = getRandomInt(party.start, party.end)
            var critters = evalEncounterCritters(critterCount, group)
            groups.push({critters: critters, position: position, target: "player"})
        }
        else if(encounter.enc.type === "fighting") {
            // two factions fighting
            var firstParty = encounter.enc.firstParty
            var secondParty = encounter.enc.secondParty
            console.log("two factions: %o vs %o", firstParty, secondParty)

            if(!firstParty) throw Error();

            var firstGroup = Worldmap.getEncounterGroup(firstParty.name)
            var firstCritterCount = getRandomInt(firstParty.start, firstParty.end)
            groups.push({critters: evalEncounterCritters(firstCritterCount, firstGroup), target: 1, position: firstGroup.position})

            // one-party fighting? TODO: check what all is allowed with `fighting`
            if(secondParty && secondParty.name !== undefined) {
                var secondGroup = Worldmap.getEncounterGroup(secondParty.name)
                var secondCritterCount = getRandomInt(secondParty.start, secondParty.end)
                groups.push({critters: evalEncounterCritters(secondCritterCount, secondGroup), target: 0, position: secondGroup.position})
            }
        }
        else if(encounter.enc.type === "special") {
            //console.log("TODO: special encounter type")
        }
        else throw "unknown encounter type: " + encounter.enc.type

        console.log("groups: %o", groups)

        return {mapName: mapName,
                mapLookupName: mapLookupName,
                encounter: encounter,
                encounterType: encounter.enc.type,
                groups: groups}
    }
}
