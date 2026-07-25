import { describe, expect, it } from "vitest";
import {
  DrawError,
  drawAssignments,
  isSingleCycle,
  sattoloShuffle,
  validatePairings,
} from "./draw";

const people = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

describe("drawAssignments", () => {
  it("never assigns anyone to themselves, across many group sizes and runs", () => {
    // This is the property the whole feature rests on, so test it broadly
    // rather than on one lucky example.
    for (let n = 2; n <= 50; n++) {
      for (let run = 0; run < 40; run++) {
        const group = people(n);
        const pairings = drawAssignments(group);
        expect(() => validatePairings(group, pairings)).not.toThrow();
      }
    }
  });

  it("gives everyone exactly one giver and one recipient", () => {
    const group = people(12);
    const pairings = drawAssignments(group);

    expect(new Set(pairings.map((p) => p.giver)).size).toBe(12);
    expect(new Set(pairings.map((p) => p.recipient)).size).toBe(12);
  });

  it("produces a single cycle, so no two people draw each other", () => {
    for (let run = 0; run < 200; run++) {
      const pairings = drawAssignments(people(8));
      expect(isSingleCycle(pairings)).toBe(true);
    }
  });

  it("respects exclusions in both directions", () => {
    const group = people(8);
    const exclusions: Array<[string, string]> = [
      ["p0", "p1"],
      ["p2", "p3"],
    ];

    for (let run = 0; run < 200; run++) {
      const pairings = drawAssignments(group, { exclusions });
      for (const { giver, recipient } of pairings) {
        expect([giver, recipient]).not.toEqual(["p0", "p1"]);
        expect([giver, recipient]).not.toEqual(["p1", "p0"]);
        expect([giver, recipient]).not.toEqual(["p2", "p3"]);
        expect([giver, recipient]).not.toEqual(["p3", "p2"]);
      }
    }
  });

  it("reaches every possible recipient over many draws", () => {
    // Guards against a subtly biased shuffle that always excludes someone.
    const group = people(5);
    const seen = new Map<string, Set<string>>(group.map((g) => [g, new Set<string>()]));

    for (let run = 0; run < 2000; run++) {
      for (const { giver, recipient } of drawAssignments(group)) {
        seen.get(giver)!.add(recipient);
      }
    }
    for (const giver of group) {
      // Everyone except themselves should show up as a recipient eventually.
      expect(seen.get(giver)!.size).toBe(group.length - 1);
    }
  });

  it("errors clearly rather than hanging when constraints are unsatisfiable", () => {
    // With 2 people the only possible draw is the mutual pair; excluding it
    // leaves nothing, and the loop must give up with an explanation.
    expect(() =>
      drawAssignments(people(2), { exclusions: [["p0", "p1"]], maxAttempts: 50 }),
    ).toThrow(DrawError);
  });

  it("rejects groups that are too small or contain duplicates", () => {
    expect(() => drawAssignments(["solo"])).toThrow(DrawError);
    expect(() => drawAssignments(["a", "a", "b"])).toThrow(/duplicates/);
  });
});

describe("sattoloShuffle", () => {
  it("moves every element to a new index", () => {
    for (let run = 0; run < 500; run++) {
      const original = people(10);
      const shuffled = sattoloShuffle([...original]);
      original.forEach((item, i) => expect(shuffled[i]).not.toBe(item));
    }
  });
});

describe("validatePairings", () => {
  it("catches a self-assignment", () => {
    expect(() =>
      validatePairings(["a", "b"], [
        { giver: "a", recipient: "a" },
        { giver: "b", recipient: "b" },
      ]),
    ).toThrow(/themselves/);
  });

  it("catches a duplicated recipient", () => {
    expect(() =>
      validatePairings(["a", "b", "c"], [
        { giver: "a", recipient: "c" },
        { giver: "b", recipient: "c" },
        { giver: "c", recipient: "a" },
      ]),
    ).toThrow(/receives more than once/);
  });
});
