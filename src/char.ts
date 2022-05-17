/*
Copyright 2014 darkf, Stratege
Copyright 2017 darkf

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

import { skillDependencies, skillImprovementCost, statDependencies } from "./skills.js";
import { clamp } from "./util.js";

// Character Stats and Skills

// TODO: "Melee Weapons" skill is called "Melee" in the PRO

export class SkillSet {
    baseSkills: { [name: string]: number } = {};
    tagged: string[] = [];
    skillPoints: number = 0;

    constructor(baseSkills?: { [name: string]: number }, tagged?: string[], skillPoints?: number) {
        // Copy construct a SkillSet
        if(baseSkills) this.baseSkills = baseSkills;
        if(tagged) this.tagged = tagged;
        if(skillPoints) this.skillPoints = skillPoints;
    }

    clone(): SkillSet {
        return new SkillSet(this.baseSkills, this.tagged, this.skillPoints);
    }

    static fromPro(skills: any): SkillSet {
        // console.log("fromPro: %o", skills);

        return new SkillSet(skills);
    }

    getBase(skill: string): number {
        const skillDep = skillDependencies[skill];

        if(!skillDep)
            throw Error(`No dependencies for skill '${skill}'`);

        return this.baseSkills[skill] || skillDep.startValue;
    }

    get(skill: string, stats: StatSet): number {
        const base = this.getBase(skill);
        const skillDep = skillDependencies[skill];

        if(!skillDep)
            throw Error(`No dependencies for skill '${skill}'`);

        let skillValue = base;

        if(this.isTagged(skill)) {
            // Tagged skills add +20 skill value to the minimum, and increments afterwards by 2x
            skillValue = skillDep.startValue + (skillValue - skillDep.startValue) * 2 + 20;
        }

        for(const dep of skillDep.dependencies) {
            if(dep.statType)
                skillValue += Math.floor(stats.get(dep.statType) * dep.multiplier);
        }

        return skillValue;
    }

    setBase(skill: string, skillValue: number) {
        this.baseSkills[skill] = skillValue;
    }

    // TODO: Respect min and max bounds in inc/dec

    incBase(skill: string, useSkillPoints: boolean=true): boolean {
        const base = this.getBase(skill);

        if(useSkillPoints) {
            const cost = skillImprovementCost(base);

            if(this.skillPoints < cost) {
                // Not enough skill points to increment
                return false;
            }

            this.skillPoints -= cost;
        }

        this.setBase(skill, base + 1);
        return true;
    }

    decBase(skill: string, useSkillPoints: boolean=true) {
        const base = this.getBase(skill);

        if(useSkillPoints) {
            const cost = skillImprovementCost(base - 1);
            this.skillPoints += cost;
        }

        this.setBase(skill, base - 1);
    }

    isTagged(skill: string): boolean {
        return this.tagged.indexOf(skill) !== -1;
    }

    // TODO: There should be a limit on the number of tagged skills (3 by default)

    tag(skill: string) {
        this.tagged.push(skill);
    }

    untag(skill: string) {
        if(this.isTagged(skill))
            this.tagged.splice(this.tagged.indexOf(skill), 1);
    }
}

export class StatSet {
    baseStats: { [name: string]: number } = {};
    useBonuses: boolean;

    constructor(baseStats?: { [name: string]: number }, useBonuses: boolean=true) {
        // Copy construct a StatSet
        if(baseStats) this.baseStats = baseStats;
        this.useBonuses = useBonuses;
    }

    clone(): StatSet {
        return new StatSet(this.baseStats, this.useBonuses);
    }

    static fromPro(pro: any): StatSet {
        // console.log("stats fromPro: %o", pro);

        const { baseStats, bonusStats } = pro.extra;

        const stats = Object.assign({}, baseStats);

        for(const stat in stats) {
            if(bonusStats[stat] !== undefined)
                stats[stat] += bonusStats[stat];
        }

        // TODO: armor, appears to be hardwired into the proto?

        // Define Max HP = HP if it does not exist
        if(stats["Max HP"] === undefined && stats["HP"] !== undefined)
            stats["Max HP"] = stats["HP"];

        // Define HP = Max HP if it does not exist
        if(stats["HP"] === undefined && stats["Max HP"] !== undefined)
            stats["HP"] = stats["Max HP"];

        return new StatSet(stats, false);
    }

    getBase(stat: string): number {
        const statDep = statDependencies[stat];

        if(!statDep)
            throw Error(`No dependencies for stat '${stat}'`);

        return this.baseStats[stat] || statDep.defaultValue;
    }

    get(stat: string): number {
        const base = this.getBase(stat);

        const statDep = statDependencies[stat];

        if(!statDep)
            throw Error(`No dependencies for stat '${stat}'`);

        let statValue = base;
        if(this.useBonuses) {
            for(const dep of statDep.dependencies) {
                if(dep.statType)
                    statValue += Math.floor(this.get(dep.statType) * dep.multiplier);
            }
        }

        return clamp(statDep.min, statDep.max, statValue);
    }

    setBase(stat: string, statValue: number) {
        this.baseStats[stat] = statValue;
    }

    modifyBase(stat: string, change: number) {
        this.setBase(stat, this.getBase(stat) + change);
    }
}
