/*
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

import { transpile } from './transpiler.js'
import { IntFile } from './intfile.js'
import { arrayIncludes, BinaryReader } from './util.js'
import { Config } from './config.js'

// Scripting VM for .INT files

function binop(f: (x: any, y: any) => any) {
    return function (this: ScriptVM) {
        var rhs = this.pop()
        this.push(f(this.pop(), rhs))
    }
}

export const opMap: { [opcode: number]: (this: ScriptVM) => void } = {
    0x8002: function () {}, // start critical (nop)
    0xc001: function () {
        this.push(this.script.read32())
    }, // op_push_d
    0x800d: function () {
        this.retStack.push(this.pop())
    }, // op_d_to_a
    0x800c: function () {
        this.push(this.popAddr())
    }, // op_a_to_d
    0x801a: function () {
        this.pop()
    }, // op_pop
    0x8004: function () {
        this.pc = this.pop()
    }, // op_jmp
    0x8003: function () {}, // op_critical_done (nop)
    0x802b: function () {
        // op_push_base
        var argc = this.pop()
        this.retStack.push(this.dvarBase)
        this.dvarBase = this.dataStack.length - argc
        // console.log("op_push_base (argc %d)", argc)
    },
    0x8019: function () {
        // op_swapa
        var a = this.popAddr()
        var b = this.popAddr()
        this.retStack.push(a)
        this.retStack.push(b)
    },
    0x802a: function () {
        this.dataStack.splice(this.dvarBase)
    }, // op_pop_to_base
    0x8029: function () {
        this.dvarBase = this.popAddr()
    }, // op_pop_base
    0x802c: function () {
        this.svarBase = this.dataStack.length
    }, // op_set_global
    0x8013: function () {
        var num = this.pop()
        this.dataStack[this.svarBase + num] = this.pop()
    }, // op_store_global
    0x8012: function () {
        var num = this.pop()
        this.push(this.dataStack[this.svarBase + num])
    }, // op_fetch_global
    0x801c: function () {
        // op_pop_return
        var addr = this.popAddr()
        if (addr === -1) this.halted = true
        else this.pc = addr
    },
    0x8010: function () {
        this.halted = true /*console.log("op_exit_prog")*/
    }, // op_exit_prog

    0x802f: function () {
        if (!this.pop()) {
            this.pc = this.pop()
        } else this.pop()
    }, // op_if
    0x8031: function () {
        var varNum = this.pop()
        this.dataStack[this.dvarBase + varNum] = this.pop()
    }, // op_store
    0x8032: function () {
        this.push(this.dataStack[this.dvarBase + this.pop()])
    }, // op_fetch
    0x8046: function () {
        this.push(-this.pop())
    }, // op_negate
    0x8044: function () {
        this.push(Math.floor(this.pop()))
    }, // op_floor (TODO: should we truncate? Test negatives)
    0x801b: function () {
        this.push(this.dataStack[this.dataStack.length - 1])
    }, // op_dup

    0x8030: function () {
        // op_while
        var cond = this.pop()
        if (!cond) {
            var pc = this.pop()
            this.pc = pc
        }
    },

    0x8028: function () {
        // op_lookup_string_proc (look up procedure index by name)
        this.push(this.intfile.procedures[this.pop()].index)
    },
    0x8027: function () {
        // op_check_arg_count
        var argc = this.pop()
        var procIdx = this.pop()
        var proc = this.intfile.proceduresTable[procIdx]
        console.log('CHECK ARGS: argc=%d procIdx=%d, proc=%o', argc, procIdx, proc)
        if (argc !== proc.argc) throw `vm error: expected ${proc.argc} args, got ${argc} args when calling ${proc.name}`
    },

    //,0x806B: function() { console.log("DISPLAY: %s", this.pop()) }

    0x8005: function () {
        // op_call (TODO: verify)
        // the script should have already pushed the return value (and possibly argc)
        this.pc = this.intfile.proceduresTable[this.pop()].offset
    },
    0x9001: function () {
        // push a string from either the strings or identifiers table.
        // normally Fallout 2 checks the type of the operand per-instruction
        // and treats the actual operand however it wants. in this case,
        // it will either be treated like a string, or an identifier.
        //
        // we just check the next instruction and match it up with the set of
        // instructions who use it as an identifier (whom use interpretGetName).

        var num = this.script.read32()
        var nextOpcode = this.script.peek16()

        if (
            arrayIncludes(
                [
                    0x8014, // op_fetch_external
                    0x8015, // op_store_external
                    0x8016, // op_export_var
                    //,0x8017 // op_export_proc (TODO: verify)
                    //,0x8005: // op_call (TODO: verify, might need more operands)
                ],
                nextOpcode
            )
        ) {
            // fetch an identifier
            if (this.intfile.identifiers[num] === undefined)
                throw Error('ScriptVM: 9001 requested identifier ' + num + " but it doesn't exist")
            this.push(this.intfile.identifiers[num])
        } else {
            // fetch a string
            if (this.intfile.strings[num] === undefined)
                throw Error('ScriptVM: 9001 requested string ' + num + " but it doesn't exist")
            this.push(this.intfile.strings[num])
        }
    },

    // logic/comparison
    0x8045: function () {
        this.push(!this.pop())
    },
    0x8033: binop(function (x, y) {
        return x == y
    }),
    0x8034: binop(function (x, y) {
        return x != y
    }),
    0x8035: binop(function (x, y) {
        return x <= y
    }),
    0x8036: binop(function (x, y) {
        return x >= y
    }),
    0x8037: binop(function (x, y) {
        return x < y
    }),
    0x8038: binop(function (x, y) {
        return x > y
    }),
    0x803e: binop(function (x, y) {
        return x && y
    }),
    0x803f: binop(function (x, y) {
        return x || y
    }),
    0x8040: binop(function (x, y) {
        return x & y
    }),
    0x8041: binop(function (x, y) {
        return x | y
    }),
    0x8039: binop(function (x, y) {
        return x + y
    }),
    0x803a: binop(function (x, y) {
        return x - y
    }),
    0x803b: binop(function (x, y) {
        return x * y
    }),
    0x803d: binop(function (x, y) {
        return x % y
    }),
    0x803c: binop(function (x, y) {
        return (x / y) | 0
    }), // TODO: truncate or not?
}

export class ScriptVM {
    script: BinaryReader
    intfile: IntFile
    pc: number = 0
    dataStack: any[] = []
    retStack: number[] = []
    svarBase: number = 0
    dvarBase: number = 0
    halted: boolean = false

    constructor(script: BinaryReader, intfile: IntFile) {
        this.script = script
        this.intfile = intfile
    }

    push(value: any): void {
        this.dataStack.push(value)
    }

    pop(): any {
        if (this.dataStack.length === 0) throw 'VM data stack underflow'
        return this.dataStack.pop()
    }

    popAddr(): any {
        if (this.retStack.length === 0) throw 'VM return stack underflow'
        return this.retStack.pop()
    }

    dis(): string {
        var offset = this.script.offset
        var disassembly = transpile(this.intfile, this.script)
        this.script.seek(offset)
        return disassembly
    }

    // call a named procedure
    call(procName: string, args: any[] = []): any {
        var proc = this.intfile.procedures[procName]
        // console.log("CALL " + procName + " @ " + proc.offset + " from " + this.scriptObj.scriptName)
        if (!proc) throw 'ScriptVM: unknown procedure ' + procName

        // TODO: which way are args passed on the stack?
        args.reverse()
        args.forEach((arg) => this.push(arg))
        this.push(args.length)

        this.retStack.push(-1) // push return address (TODO: how is this handled?)

        // run procedure code
        this.pc = proc.offset
        this.run()

        return this.pop()
    }

    step(): boolean {
        if (this.halted) return false

        // fetch op
        var pc = this.pc
        this.script.seek(pc)
        var opcode = this.script.read16()

        // dispatch based on opMap
        if (opMap[opcode] !== undefined) opMap[opcode].call(this)
        else {
            console.warn(
                'unimplemented opcode %s (pc=%s) in %s',
                opcode.toString(16),
                this.pc.toString(16),
                this.intfile.name
            )
            if (Config.engine.doDisasmOnUnimplOp) {
                console.log('disassembly:')
                console.log(transpile(this.intfile, this.script))
            }
            return false
        }

        if (this.pc === pc)
            // PC wasn't explicitly set, let's advance it to the current file offset
            this.pc = this.script.offset
        return true
    }

    run(): void {
        this.halted = false
        while (this.step()) {}
    }
}
