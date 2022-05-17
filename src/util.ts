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

import { Critter } from "./critter.js"
import { loadMessage } from "./data.js"
import globalState from "./globalState.js"

// Utility functions

export function parseIni(text: string) {
    // Parse a .ini-style categorized key-value format
    const ini: { [category: string]: any } = {}
    const lines = text.split('\n')
    let category = null

    for(var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\s*;.*/, "") // replace comments
        if(line.trim() === '') { }
        else if(line[0] === '[')
            category = line.trim().slice(1, -1)
        else {
            // key=value
            var kv = line.match(/(.+?)=(.+)/)
            if(kv === null) { // MAPS.TXT has one of these, so it's not an exception
                console.log("warning: parseIni: not a key=value line: " + line)
                continue
            }
            if(category === null) throw "parseIni: key=value not in category: " + line

            if(ini[category] === undefined) ini[category] = {}
            ini[category][kv[1]] = kv[2]
        }
    }

    return ini
}

export function getFileText(path: string, err?: () => void): string {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", path, false);
    xhr.send(null);
    if(xhr.status !== 200)
        throw Error(`getFileText: got status ${xhr.status} when requesting '${path}'`);

    return xhr.responseText;
}

export function getFileJSON(path: string, err?: () => void): any {
    return JSON.parse(getFileText(path, err));
}

// GET binary data into a DataView
function getFileBinaryAsync(path: string, callback: (data: DataView) => void) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", path, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = (evt) => { callback(new DataView(xhr.response)); };
    xhr.send(null);
}

export function getFileBinarySync(path: string) {
    // Synchronous requests aren't allowed by browsers to define response types
    // in a misguided attempt to force developers to switch to asynchronous requests,
    // so we transfer as a user-defined charset and then decode it manually.
    
    const xhr = new XMLHttpRequest();
    xhr.open("GET", path, false);
    // Tell browser not to mess with the response type/encoding
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send(null);

    if(xhr.status !== 200)
        throw Error(`getFileBinarySync: got status ${xhr.status} when requesting '${path}'`);

    // Convert to ArrayBuffer, and then to DataView
    const data = xhr.responseText;
    const buffer = new ArrayBuffer(data.length);
    const arr = new Uint8Array(buffer);

    for(let i = 0; i < data.length; i++)
        arr[i] = data.charCodeAt(i) & 0xff;

    return new DataView(buffer);
}

// Min inclusive, max inclusive
export function getRandomInt(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

export function rollSkillCheck(skill: number, modifier: number, isBounded: boolean) {
    const tempSkill = skill + modifier
    if(isBounded)
        clamp(0, 95, tempSkill)

    const roll = getRandomInt(0,100)
    return roll < tempSkill
}

function rollVsSkill(who: Critter, skill: string, modifier: number=0) {
    var skillLevel = who.getSkill(skill) + modifier
    var roll = skillLevel - getRandomInt(1, 100)

    if(roll <= 0) { // failure
        if((-roll)/10 > getRandomInt(1, 100))
            return 0 // critical failure
        return 1 // failure
    }
    else { // success
        var critChance = who.getStat("Critical Chance")
        if((roll/10 + critChance) > getRandomInt(1, 100))
            return 3 // critical success
        return 2 // success
    }
}

function rollIsSuccess(roll: number) {
    return (roll == 2) || (roll == 3)
}

function rollIsCritical(roll: number) {
    return (roll == 0) || (roll == 3)
}

export function arrayRemove<T>(array: T[], value: T) {
    const index = array.indexOf(value)
    if(index !== -1) {
        array.splice(index, 1)
        return true
    }
    return false
}

export function arrayWithout<T>(array: T[], value: T): T[] {
    return array.filter(x => x !== value);
}

export function arrayIncludes<T>(array: T[], value: T): boolean {
    return array.indexOf(value) !== -1;
}

export function clamp(min: number, max: number, value: number) {
    return Math.max(min, Math.min(max, value))
}

export function getMessage(name: string, id: number): string|null {
    if(globalState.messageFiles[name] !== undefined && globalState.messageFiles[name][id] !== undefined)
        return globalState.messageFiles[name][id]
    else {
        loadMessage(name)
        if(globalState.messageFiles[name] !== undefined && globalState.messageFiles[name][id] !== undefined)
            return globalState.messageFiles[name][id]
        else return null
    }
}

export function getProtoMsg(id: number) {
    return getMessage("proto", id)
}

export function pad(n: any, width: number, z?: string) {
  z = z || '0';
  n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

export class BinaryReader {
    data: DataView
    offset: number = 0
    length: number

    constructor(data: DataView) {
        this.data = data
        this.length = data.byteLength
    }

    seek(offset: number) { this.offset = offset }
    read8(): number { return this.data.getUint8(this.offset++) }
    read16(): number { var r = this.data.getUint16(this.offset); this.offset += 2; return r }
    read32(): number { var r = this.data.getUint32(this.offset); this.offset += 4; return r }

    peek8(): number { return this.data.getUint8(this.offset) }
    peek16(): number { return this.data.getUint16(this.offset) }
    peek32(): number { return this.data.getUint32(this.offset) }
}

export function assert(value: boolean, message: string) {
    if(!value)
        throw "AssertionError: " + message
}

export function assertEq<T>(value: T, expected: T, message: string) {
    if(value !== expected)
        throw `AssertionError: value (${value}) does not match expected (${expected}): ${message}`
}

declare function structuredClone(value: any, options?: StructuredSerializeOptions): any;

export function deepClone<T>(obj: T): T {
    return structuredClone(obj);
}

export function isNumeric(str: string): boolean {
    return !isNaN((str as any) - parseFloat(str));
}
