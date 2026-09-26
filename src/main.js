import { geoMercator, geoPath } from "d3-geo";
import "./styles.css";

const DAY_COUNT = 90;
const MAX_INSPECTORS = 4;
const STAFFING_CANDIDATE_LIMIT = 30;
const OFFICERS_PER_TEAM = 1;
const TEAM_HOURS = 8;
const SHIFT_START_MINUTE = 660;
const CHECK_MINUTES = 5;
const JOURNEY_MINUTES = 35;
const PLAY_STEP_MINUTES = 5;
const RIDER_SAMPLE_SIZE = 50;
const START_MINUTE = 300;
const END_MINUTE = 1410;
const BIN_MINUTES = 15;
const BIN_COUNT = Math.floor((END_MINUTE - START_MINUTE) / BIN_MINUTES) + 1;
const FARE_BENCHMARK = 111_419_000;
const DAYS_PER_YEAR = 365;

const STRATEGIES = [
  { id: "busiest", label: "Best modeled return", sub: "Marginal fares + fines · rotate" },
  { id: "regular", label: "Distributed exposure", sub: "Spread across busy lines" },
  { id: "random", label: "Random ride-alongs", sub: "Route chosen at random" },
  { id: "pulse", label: "Pulse, then rotate", sub: "Concentrate, then move on" },
  { id: "none", label: "No enforcement", sub: "Baseline comparison" },
];

const el = (id) => document.getElementById(id);
const state = {
  day: 18,
  minute: 1050,
  strategy: "busiest",
  teamCount: 1,
  staffingCurve: [],
  staffingLimitReached: false,
  selectedStopId: null,
  focusRouteId: "all",
  scenarios: new Map(),
  map: null,
  mapSvg: null,
  projection: null,
  mapPath: null,
  playing: false,
  timer: null,
  simBusy: false,
  pendingModelUpdate: false,
  modelReady: false,
  analyticsReady: false,
  analyticsRunning: false,
};

const formatMoney = (value, compact = false, digits = 0) => {
  const abs = Math.abs(value);
  if (compact && abs >= 1_000_000) return `${value < 0 ? "−" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
  if (compact && abs >= 10_000) return `${value < 0 ? "−" : ""}$${(abs / 1000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
};
const formatNumber = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.max(0, Math.round(value)));
const clamp = (number, low, high) => Math.max(low, Math.min(high, number));
const binForMinute = (minute) => clamp(Math.round((minute - START_MINUTE) / BIN_MINUTES), 0, BIN_COUNT - 1);
const minuteForBin = (bin) => START_MINUTE + bin * BIN_MINUTES;
const timeLabel = (minute, compact = false) => {
  const hour = Math.floor(minute / 60);
  const mins = minute % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  if (compact && mins === 0) return `${hour12}${suffix.toLowerCase()}`;
  return `${hour12}:${String(mins).padStart(2, "0")} ${suffix}`;
};
const colorForProbability = (probability, baseline) => {
  const neutral = [185, 194, 190];
  const target = probability < baseline ? [199, 75, 48] : [8, 112, 91];
  const intensity = Math.sqrt(clamp(Math.abs(probability - baseline) / 0.25, 0, 1));
  return `rgb(${neutral.map((n, i) => Math.round(n + (target[i] - n) * intensity)).join(",")})`;
};
const changeLabel = (probability, baseline) => {
  const pp = Math.round((probability - baseline) * 100);
  return pp === 0 ? "at baseline" : `${pp > 0 ? "+" : ""}${pp} pp vs baseline`;
};

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function modelInputs() {
  return {
    baseline: Number(el("baselineInput").value) / 100,
    visibleLift: Number(el("visibleLiftInput").value) / 100,
    directLift: Number(el("directLiftInput").value) / 100,
    checksPerMinute: Number(el("rateInput").value),
    citationRate: Number(el("citationRateInput").value) / 100,
    fineAmount: Number(el("fineInput").value),
    fineCollectionRate: Number(el("collectionInput").value) / 100,
    timeSpread: Number(el("spreadInput").value),
    decayRate: Number(el("decayInput").value),
    teamAnnualCost: Number(el("staffCostInput").value),
    fare: Number(el("fareInput").value),
    temperature: Number(el("temperatureInput").value) / 100,
    routeCarryover: Number(el("routeCarryoverInput").value) / 100,
    coveredFareShare: Number(el("coveredFareShareInput").value) / 100,
    discountFareShare: Number(el("discountFareShareInput").value) / 100,
  };
}

function fareRevenueFactor(inputs) {
  return (1 - inputs.coveredFareShare) * (1 - inputs.discountFareShare * 0.5);
}

function chooseByTemperature(scoredOptions, random, temperature) {
  if (!scoredOptions.length) return null;
  const ordered = scoredOptions.slice().sort((a, b) => b.score - a.score);
  if (temperature <= 0 || ordered.length === 1) return ordered[0];
  const best = ordered[0].score;
  const range = best - ordered[ordered.length - 1].score;
  if (range <= 1e-9) return ordered[Math.floor(random() * ordered.length)];
  const scale = range * temperature;
  const weights = ordered.map(({ score }) => Math.exp(Math.max(-40, (score - best) / scale)));
  const draw = random() * weights.reduce((sum, weight) => sum + weight, 0);
  let cumulative = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    cumulative += weights[index];
    if (draw <= cumulative) return ordered[index];
  }
  return ordered[0];
}

function gaussianWeights() {
  const raw = [];
  for (let bin = 0; bin < BIN_COUNT; bin += 1) {
    const hour = minuteForBin(bin) / 60;
    const gaussian = (mean, sigma) => Math.exp(-0.5 * ((hour - mean) / sigma) ** 2);
    raw.push(0.12 + 0.9 * gaussian(8.1, 1.45) + 0.34 * gaussian(12.5, 2.3) + 0.92 * gaussian(17.4, 1.75));
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((value) => value / sum);
}

function buildDataIndex(data) {
  data.routeById = new Map(data.routes.map((route) => [route.id, route]));
  data.stopById = new Map(data.stops.map((stop) => [stop.id, stop]));
  data.routeBoardingsPerStop = new Map();
  for (const route of data.routes) {
    data.routeBoardingsPerStop.set(route.id, route.weekdayBoardings / Math.max(1, route.stopIds.length));
  }
  data.hourlyWeights = gaussianWeights();
  data.stopsByRoute = new Map();
  for (const route of data.routes) {
    data.stopsByRoute.set(route.id, route.stopIds.map((id) => data.stopById.get(id)).filter(Boolean));
  }
  data.scheduledTripsByRoute = new Map(data.routes.map((route) => [route.id, []]));
  for (const trip of data.schedule.trips) data.scheduledTripsByRoute.get(trip.routeId)?.push(trip);
  for (const route of data.routes) route.scheduledTripCount = data.scheduledTripsByRoute.get(route.id)?.length || 0;
  data.journeyCandidatesBySlot = new Map();
  return data;
}

function expectedBoardings(data, routeId, stopId, bin) {
  const route = data.routeById.get(routeId);
  if (!route) return 0;
  const stopIds = route.stopIds;
  if (!stopIds.includes(stopId)) return 0;
  const routeTotalByStop = (data.routeBoardingsPerStop.get(routeId) || 0) * Math.max(0.2, Number(route.boardingShare ?? 1));
  return routeTotalByStop * data.hourlyWeights[bin];
}

function visibleRiderAssumption(route) {
  if (route.weekdayBoardings >= 20_000) return 50;
  if (route.weekdayBoardings >= 10_000) return 40;
  return 25;
}

function makeRiders(cohortKey, baseline) {
  const random = seeded(hashString(cohortKey));
  const riders = [];
  for (let i = 0; i < RIDER_SAMPLE_SIZE / 2; i += 1) {
    const u1 = Math.max(random(), 1e-9);
    const u2 = random();
    const deviation = Math.min(0.45, baseline, 1 - baseline, Math.abs(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 0.16));
    riders.push({ id: i * 2, baseline: baseline - deviation, boost: 0, observations: [], directChecks: 0, observedChecks: 0, lastEvent: null });
    riders.push({ id: i * 2 + 1, baseline: baseline + deviation, boost: 0, observations: [], directChecks: 0, observedChecks: 0, lastEvent: null });
  }
  for (let i = riders.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [riders[i], riders[j]] = [riders[j], riders[i]];
  }
  riders.forEach((rider, index) => { rider.id = index; });
  return riders;
}

function selectDirectIds(cohortKey, day, eventIndex, directCount) {
  const random = seeded(hashString(`${cohortKey}|${day}|${eventIndex}`));
  const ids = Array.from({ length: RIDER_SAMPLE_SIZE }, (_, i) => i);
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return new Set(ids.slice(0, directCount));
}

function journeyCandidates(data, slotStart) {
  if (data.journeyCandidatesBySlot.has(slotStart)) return data.journeyCandidatesBySlot.get(slotStart);
  const candidates = [];
  const firstTarget = slotStart + 5;
  const secondTarget = slotStart + 20;
  for (const trip of data.schedule.trips) {
    const route = data.routeById.get(trip.routeId);
    if (!route || route.type === "Muni Metro") continue;
    const stops = trip.stops;
    for (let first = 2; first < stops.length - 2; first += 1) {
      const position = first / (stops.length - 1);
      if (position < 0.28 || position > 0.72) continue;
      const firstStop = stops[first];
      if (Math.abs(firstStop[1] - firstTarget) > 5) continue;
      for (let second = first + 3; second < stops.length - 1; second += 1) {
        const secondStop = stops[second];
        const gap = secondStop[1] - firstStop[1];
        if (gap > 22) break;
        if (gap < 11 || Math.abs(secondStop[1] - secondTarget) > 5) continue;
        let board = first - 1;
        while (board > 0 && stops[board][2] > slotStart + 1) board -= 1;
        if (stops[board][2] < slotStart - 7 || stops[board][2] > slotStart + 2) continue;
        const alight = Math.min(second + 1, stops.length - 1);
        if (stops[alight][1] > slotStart + JOURNEY_MINUTES) continue;
        const midpointWeight = 1 - Math.abs(position - 0.5) * 1.6;
        const averageBoardingsPerTrip = route.weekdayBoardings / Math.max(1, route.scheduledTripCount);
        const expectedOnboard = clamp(Math.round(averageBoardingsPerTrip * 0.65 * midpointWeight), 20, 70);
        const timingFit = Math.abs(firstStop[1] - firstTarget) + Math.abs(secondStop[1] - secondTarget);
        candidates.push({
          trip,
          route,
          stops,
          boardIndex: board,
          boardMinute: stops[board][2],
          boardStopId: stops[board][0],
          firstIndex: first,
          secondIndex: second,
          alightIndex: alight,
          events: [
            { stopId: firstStop[0], minute: firstStop[1], position },
            { stopId: secondStop[0], minute: secondStop[1], position: second / (stops.length - 1) },
          ],
          alightMinute: stops[alight][1],
          expectedOnboard,
          score: expectedOnboard * midpointWeight - timingFit * 0.4,
        });
      }
    }
  }
  data.journeyCandidatesBySlot.set(slotStart, candidates);
  return candidates;
}

function transferMinutes(data, fromStopId, toStopId) {
  const from = data.stopById.get(fromStopId);
  const to = data.stopById.get(toStopId);
  if (!from || !to) return 12;
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(to.lat - from.lat);
  const dLon = radians(to.lon - from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLon / 2) ** 2;
  const meters = 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.max(2, Math.ceil(meters / 70) + 2);
}

function marginalReturnScore(candidate, data, inputs, cohortHistory, day, horizonDays = DAY_COUNT) {
  const checked = Math.min(candidate.expectedOnboard, inputs.checksPerMinute * CHECK_MINUTES);
  const dueFareOnboard = candidate.expectedOnboard * (1 - inputs.coveredFareShare);
  const eligibleChecks = checked * (1 - inputs.coveredFareShare);
  const directShare = dueFareOnboard > 0 ? Math.min(1, eligibleChecks / dueFareOnboard) : 0;
  const lift = inputs.visibleLift + directShare * inputs.directLift;
  const remainingDays = horizonDays - day + 1;
  const decaySum = (1 - Math.exp(-inputs.decayRate * remainingDays)) / (1 - Math.exp(-inputs.decayRate));
  let returnScore = 0;
  const spreadBins = Math.max(1, Math.ceil((inputs.timeSpread * 2) / BIN_MINUTES));
  for (const event of candidate.events) {
    let fareValue = 0;
    for (let offset = -spreadBins; offset <= spreadBins; offset += 1) {
      const impactedMinute = event.minute + offset * BIN_MINUTES;
      if (impactedMinute < START_MINUTE || impactedMinute > END_MINUTE) continue;
      const impactScale = Math.exp(-0.5 * ((offset * BIN_MINUTES) / inputs.timeSpread) ** 2);
      const bin = binForMinute(impactedMinute);
      const cohortKey = `${candidate.route.id}|${event.stopId}|${bin}`;
      const previousLift = cohortHistory.get(cohortKey) || 0;
      const headroom = clamp((1 - inputs.baseline - previousLift) / Math.max(0.01, 1 - inputs.baseline), 0, 1);
      const demand = expectedBoardings(data, candidate.route.id, event.stopId, bin);
      fareValue += demand * inputs.fare * fareRevenueFactor(inputs) * lift * impactScale * decaySum * headroom;
    }
    const inspectionKey = `${candidate.route.id}|${event.stopId}|${binForMinute(event.minute)}`;
    const unpaidChance = Math.max(0, 1 - inputs.baseline - (cohortHistory.get(inspectionKey) || 0));
    const eligibleChecks = checked * (1 - inputs.coveredFareShare);
    const citations = Math.min(eligibleChecks * unpaidChance, eligibleChecks * inputs.citationRate);
    const fineValue = citations * inputs.fineAmount * inputs.fineCollectionRate;
    returnScore += fareValue + fineValue;
  }
  return returnScore;
}

function makeSchedule(data, strategy, inputs, teamCount = state.teamCount, horizonDays = DAY_COUNT) {
  const days = Array.from({ length: horizonDays + 1 }, () => []);
  const journeysByDay = Array.from({ length: horizonDays + 1 }, () => []);
  if (strategy === "none" || teamCount <= 0) return { days, journeysByDay };
  const cohortHistory = new Map();
  const routeCoverage = new Map();
  for (let day = 1; day <= horizonDays; day += 1) {
    if (day > 1) for (const [key, lift] of cohortHistory) cohortHistory.set(key, lift * Math.exp(-inputs.decayRate));
    if (day > 1) for (const [routeId, coverage] of routeCoverage) routeCoverage.set(routeId, coverage * 0.55);
    const teamState = Array.from({ length: teamCount }, (_, team) => ({
      random: seeded(hashString(`${strategy}|${day}|${team}|muni-gtfs-lab`)),
      routeUse: new Map(), recentRoutes: [],
      previousAlightMinute: SHIFT_START_MINUTE - 5, previousAlightStopId: null,
    }));
    for (let block = 0; block < Math.floor(TEAM_HOURS * 60 / JOURNEY_MINUTES); block += 1) {
      const slotStart = SHIFT_START_MINUTE + block * JOURNEY_MINUTES;
      const scheduledThisBlock = [];
      for (let team = 0; team < teamCount; team += 1) {
        const crew = teamState[team];
        const available = journeyCandidates(data, slotStart).filter((candidate) => {
          const canTransfer = candidate.boardMinute >= crew.previousAlightMinute + (crew.previousAlightStopId ? transferMinutes(data, crew.previousAlightStopId, candidate.boardStopId) : 0);
          const tripFree = !scheduledThisBlock.some((other) => other.tripId === candidate.trip.id && other.boardMinute < candidate.alightMinute && candidate.boardMinute < other.alightMinute);
          return canTransfer && tripFree;
        });
        const options = strategy === "busiest" && available.length > STAFFING_CANDIDATE_LIMIT
          ? available.sort((a, b) => b.score - a.score).slice(0, STAFFING_CANDIDATE_LIMIT)
          : available;
        if (!options.length) continue;
        let selected;
        if (strategy === "random") {
          selected = options[Math.floor(crew.random() * options.length)];
        } else if (strategy === "pulse") {
          const ordered = data.routes.filter((route) => route.type !== "Muni Metro").sort((a, b) => b.weekdayBoardings - a.weekdayBoardings);
          const pulseRoute = ordered[Math.floor(block / 2 + team) % Math.min(12, ordered.length)];
          const pulseOptions = options.filter((option) => option.route.id === pulseRoute?.id);
          selected = (pulseOptions.length ? pulseOptions : options).sort((a, b) => b.score - a.score)[0];
        } else {
          const scored = options.map((option) => {
            const uses = crew.routeUse.get(option.route.id) || 0;
            const repeatPenalty = crew.recentRoutes[0] === option.route.id ? 0.3 : crew.recentRoutes.includes(option.route.id) ? 0.65 : 1;
            const globalRoutePenalty = 1 / (1 + (routeCoverage.get(option.route.id) || 0) * 0.18);
            let score = strategy === "busiest" ? marginalReturnScore(option, data, inputs, cohortHistory, day, horizonDays) * repeatPenalty * globalRoutePenalty : option.score * repeatPenalty * globalRoutePenalty;
            if (strategy === "regular") score /= 1 + uses * 0.3;
            return { option, score };
          });
          selected = strategy === "busiest"
            ? chooseByTemperature(scored, crew.random, inputs.temperature)?.option
            : scored.reduce((best, candidate) => !best || candidate.score > best.score ? candidate : best, null)?.option;
        }
        if (!selected) continue;
        const journeyId = `${strategy}-${day}-${team}-${block}`;
        const journey = {
          id: journeyId, team, tripId: selected.trip.id, routeId: selected.route.id,
          routeShort: selected.route.short, headsign: selected.trip.headsign, stops: selected.stops,
          boardIndex: selected.boardIndex, boardMinute: selected.boardMinute,
          alightIndex: selected.alightIndex, alightMinute: selected.alightMinute,
          boardStopId: selected.stops[selected.boardIndex][0], alightStopId: selected.stops[selected.alightIndex][0],
        };
        journeysByDay[day].push(journey);
        scheduledThisBlock.push(journey);
        crew.previousAlightMinute = journey.alightMinute;
        crew.previousAlightStopId = journey.alightStopId;
        crew.routeUse.set(selected.route.id, (crew.routeUse.get(selected.route.id) || 0) + 1);
        routeCoverage.set(selected.route.id, (routeCoverage.get(selected.route.id) || 0) + 1);
        crew.recentRoutes = [selected.route.id, ...crew.recentRoutes.filter((routeId) => routeId !== selected.route.id)].slice(0, 2);
        selected.events.forEach((inspection, index) => {
          if (!data.stopById.has(inspection.stopId)) return;
          const minute = inspection.minute;
          const cohortKey = `${selected.route.id}|${inspection.stopId}|${binForMinute(minute)}`;
          days[day].push({
            id: `${journeyId}-${index}`, journeyId, strategy, day, team,
            routeId: selected.route.id, tripId: selected.trip.id, stopId: inspection.stopId,
            pathIndex: inspection.position, minute, checkMinutes: CHECK_MINUTES,
            visibleCount: selected.expectedOnboard, cohortKey, eventIndex: (team * 100 + block) * 2 + index,
          });
          const ownRouteLift = inputs.visibleLift + (selected.expectedOnboard > 0 ? Math.min(selected.expectedOnboard, inputs.checksPerMinute * CHECK_MINUTES) / selected.expectedOnboard * inputs.directLift : 0);
          const stopRoutes = data.stopById.get(inspection.stopId)?.routes || [selected.route.id];
          const spreadBins = Math.max(1, Math.ceil((inputs.timeSpread * 2) / BIN_MINUTES));
          for (let offset = -spreadBins; offset <= spreadBins; offset += 1) {
            const impactedMinute = minute + offset * BIN_MINUTES;
            if (impactedMinute < START_MINUTE || impactedMinute > END_MINUTE) continue;
            const impactScale = Math.exp(-0.5 * ((offset * BIN_MINUTES) / inputs.timeSpread) ** 2);
            for (const routeId of stopRoutes) {
              const carryover = routeId === selected.route.id ? 1 : inputs.routeCarryover;
              if (carryover <= 0) continue;
              const response = routeId === selected.route.id ? ownRouteLift : inputs.visibleLift * carryover;
              const impactedKey = `${routeId}|${inspection.stopId}|${binForMinute(impactedMinute)}`;
              cohortHistory.set(impactedKey, (cohortHistory.get(impactedKey) || 0) + response * impactScale);
            }
          }
        });
      }
    }
  }
  return { days, journeysByDay };
}

function schedulePrefix(plan, teamCount) {
  return {
    days: plan.days.map((events) => events.filter((event) => event.team < teamCount)),
    journeysByDay: plan.journeysByDay.map((journeys) => journeys.filter((journey) => journey.team < teamCount)),
  };
}

function buildScenario(data, strategy, inputs, teamCount = state.teamCount, plannedSchedule = null) {
  const { days: schedule, journeysByDay } = plannedSchedule || makeSchedule(data, strategy, inputs, teamCount);
  const eventsByCohort = new Map();
  const allEvents = [];
  const eventById = new Map();
  for (let day = 1; day <= DAY_COUNT; day += 1) {
    for (const event of schedule[day]) {
      const capacity = inputs.checksPerMinute * OFFICERS_PER_TEAM * event.checkMinutes;
      event.checkedCount = Math.min(event.visibleCount, capacity);
      event.expectedCitations = 0;
      allEvents.push(event);
      eventById.set(event.id, event);
      const stopRoutes = data.stopById.get(event.stopId)?.routes || [event.routeId];
      const spreadBins = Math.max(1, Math.ceil((inputs.timeSpread * 2) / BIN_MINUTES));
      for (let offset = -spreadBins; offset <= spreadBins; offset += 1) {
        const impactedMinute = event.minute + offset * BIN_MINUTES;
        if (impactedMinute < START_MINUTE || impactedMinute > END_MINUTE) continue;
        const impactScale = Math.exp(-0.5 * ((offset * BIN_MINUTES) / inputs.timeSpread) ** 2);
        for (const routeId of stopRoutes) {
          const crossRoute = routeId !== event.routeId;
          if (crossRoute && inputs.routeCarryover <= 0) continue;
          const cohortKey = `${routeId}|${event.stopId}|${binForMinute(impactedMinute)}`;
          const impactedEvent = {
            ...event, routeId, cohortKey, inspectionCohortKey: event.cohortKey,
            impactScale, crossRoute,
          };
          const dueFareVisible = event.visibleCount * (1 - inputs.coveredFareShare);
          const eligibleChecks = event.checkedCount * (1 - inputs.coveredFareShare);
          impactedEvent.directCount = crossRoute || dueFareVisible <= 0 ? 0 : Math.round(RIDER_SAMPLE_SIZE * Math.min(1, eligibleChecks / dueFareVisible));
          impactedEvent.directIds = crossRoute ? new Set() : selectDirectIds(`${event.id}|${cohortKey}`, day, event.eventIndex, impactedEvent.directCount);
          if (!eventsByCohort.has(cohortKey)) eventsByCohort.set(cohortKey, []);
          eventsByCohort.get(cohortKey).push(impactedEvent);
        }
      }
    }
  }

  const cohortByKey = new Map();
  const cashflowByDay = Array.from({ length: DAY_COUNT + 1 }, () => new Array(BIN_COUNT).fill(0));
  const routeRevenue = new Map(data.routes.map((route) => [route.id, 0]));
  let gross90 = 0;
  for (const [cohortKey, events] of eventsByCohort) {
    const [routeId, stopId, binString] = cohortKey.split("|");
    const bin = Number(binString);
    const cohort = { key: cohortKey, routeId, stopId, bin, riders: makeRiders(cohortKey, inputs.baseline), events, probabilityByDay: new Array(DAY_COUNT + 1).fill(inputs.baseline), demand: expectedBoardings(data, routeId, stopId, bin) };
    events.sort((a, b) => a.day - b.day || a.minute - b.minute);
    const eventsPerDay = new Map();
    for (const event of events) {
      if (!eventsPerDay.has(event.day)) eventsPerDay.set(event.day, []);
      eventsPerDay.get(event.day).push(event);
    }
    const boostByRider = new Float64Array(RIDER_SAMPLE_SIZE);
    const personalBoostByRider = new Float64Array(RIDER_SAMPLE_SIZE);
    let eventCursor = 0;
    for (let day = 1; day <= DAY_COUNT; day += 1) {
      if (day > 1) {
        const decay = Math.exp(-inputs.decayRate);
        for (let rider = 0; rider < boostByRider.length; rider += 1) {
          boostByRider[rider] *= decay;
          personalBoostByRider[rider] *= decay;
        }
      }
      let probabilitySum = 0;
      for (let rider = 0; rider < RIDER_SAMPLE_SIZE; rider += 1) {
        probabilitySum += Math.min(1, cohort.riders[rider].baseline + boostByRider[rider] + personalBoostByRider[rider]);
      }
      let beforeChecks = probabilitySum / RIDER_SAMPLE_SIZE;
      const extra = Math.max(0, beforeChecks - inputs.baseline) * cohort.demand * inputs.fare * fareRevenueFactor(inputs);
      if (extra > 0) {
        cashflowByDay[day][bin] += extra;
        routeRevenue.set(routeId, (routeRevenue.get(routeId) || 0) + extra);
        gross90 += extra;
      }
      const todayEvents = eventsPerDay.get(day) || [];
      for (const event of todayEvents) {
        if (event.cohortKey === event.inspectionCohortKey) {
          const inspection = eventById.get(event.id);
          if (inspection) {
            const eligibleChecks = inspection.checkedCount * (1 - inputs.coveredFareShare);
            const unpaidChecks = eligibleChecks * Math.max(0, 1 - beforeChecks);
            inspection.expectedUnpaidChecks = unpaidChecks;
            inspection.checkPaymentChance = beforeChecks;
            inspection.expectedCitations = Math.min(unpaidChecks, eligibleChecks * inputs.citationRate);
          }
        }
        let afterEventProbabilitySum = 0;
        for (let rider = 0; rider < RIDER_SAMPLE_SIZE; rider += 1) {
          const visibilityLift = inputs.visibleLift * (event.crossRoute ? inputs.routeCarryover : 1);
          boostByRider[rider] += visibilityLift * event.impactScale;
          if (event.directIds.has(rider)) personalBoostByRider[rider] += inputs.directLift * event.impactScale;
          afterEventProbabilitySum += Math.min(1, cohort.riders[rider].baseline + boostByRider[rider] + personalBoostByRider[rider]);
        }
        beforeChecks = afterEventProbabilitySum / RIDER_SAMPLE_SIZE;
        for (const rider of cohort.riders) {
          if (event.directIds.has(rider.id)) rider.directChecks += 1;
          rider.observedChecks += 1;
          rider.lastEvent = { day, minute: event.minute, routeId };
          rider.observations.push({ day, minute: event.minute, direct: event.directIds.has(rider.id), visible: !event.crossRoute, crossRoute: event.crossRoute, impactScale: event.impactScale });
        }
      }
      cohort.probabilityByDay[day] = beforeChecks;
    }
    cohort.eventsByDay = eventsPerDay;
    cohortByKey.set(cohortKey, cohort);
  }

  const staffHoursPerDay = (strategy === "none" ? 0 : teamCount) * OFFICERS_PER_TEAM * TEAM_HOURS;
  const annualCost = strategy === "none" ? 0 : inputs.teamAnnualCost * teamCount;
  const costPerDay = annualCost / DAYS_PER_YEAR;
  const grossByDay = new Array(DAY_COUNT + 1).fill(0);
  const citationReceiptsByDay = new Array(DAY_COUNT + 1).fill(0);
  let expectedCitations90 = 0;
  for (let day = 1; day <= DAY_COUNT; day += 1) grossByDay[day] = cashflowByDay[day].reduce((sum, value) => sum + value, 0);
  for (let day = 1; day <= DAY_COUNT; day += 1) {
    const expectedCitations = (schedule[day] || []).reduce((sum, event) => sum + event.expectedCitations, 0);
    expectedCitations90 += expectedCitations;
    citationReceiptsByDay[day] = expectedCitations * inputs.fineAmount * inputs.fineCollectionRate;
  }
  const collectedFines90 = citationReceiptsByDay.reduce((sum, amount) => sum + amount, 0);
  const assessedFines90 = expectedCitations90 * inputs.fineAmount;
  const costs90 = annualCost * DAY_COUNT / DAYS_PER_YEAR;
  const annualFareGross = gross90 * DAYS_PER_YEAR / DAY_COUNT;
  const annualFineGross = collectedFines90 * DAYS_PER_YEAR / DAY_COUNT;
  const annualGross = annualFareGross + annualFineGross;
  return { strategy, teamCount: strategy === "none" ? 0 : teamCount, schedule, journeysByDay, eventsByCohort, cohortByKey, cashflowByDay, citationReceiptsByDay, grossByDay, routeRevenue, gross90, expectedCitations90, assessedFines90, collectedFines90, annualFareGross, annualFineGross, costs90, net90: gross90 + collectedFines90 - costs90, annualGross, annualCost, annualNet: annualGross - annualCost, staffHoursPerDay, costPerDay, allEvents };
}

function calculateStaffingCurve(data, inputs) {
  const plan = makeSchedule(data, "busiest", inputs, MAX_INSPECTORS);
  const scenarios = new Map();
  const curve = [];
  let previousScenario = null;
  let recommended = 0;
  let breakEvenFound = false;
  for (let inspectors = 1; inspectors <= MAX_INSPECTORS; inspectors += 1) {
    const scenario = buildScenario(data, "busiest", inputs, inspectors, schedulePrefix(plan, inspectors));
    const addedAnnualGross = scenario.annualGross - (previousScenario?.annualGross || 0);
    const marginalNet = addedAnnualGross - inputs.teamAnnualCost;
    curve.push({ inspectors, addedAnnualGross, annualCost: inputs.teamAnnualCost, marginalNet });
    if (marginalNet <= 0) {
      breakEvenFound = true;
      recommended = inspectors - 1;
      if (previousScenario) scenarios.set(recommended, previousScenario);
      break;
    }
    recommended = inspectors;
    previousScenario = scenario;
  }
  if (recommended === 0) scenarios.set(0, buildScenario(data, "busiest", inputs, 0, schedulePrefix(plan, 0)));
  else if (!breakEvenFound && previousScenario) scenarios.set(recommended, previousScenario);
  return { curve, scenarios, recommended, limitReached: !breakEvenFound && recommended === MAX_INSPECTORS };
}

function getProbability(data, scenario, routeId, stopId, bin, day, minute, base) {
  const cohort = scenario?.cohortByKey.get(`${routeId}|${stopId}|${bin}`);
  if (!cohort) return base;
  const events = cohort.eventsByDay.get(day) || [];
  if (events.some((event) => event.minute <= minute)) return cohort.probabilityByDay[day] ?? base;
  return cohort.probabilityByDay[Math.max(0, day - 1)] ?? base;
}

function cohortKeyFor(stopId, routeId, bin) { return `${routeId}|${stopId}|${bin}`; }

function stopRouteIds(stop) {
  if (!stop) return [];
  if (state.focusRouteId !== "all" && stop.routes.includes(state.focusRouteId)) return [state.focusRouteId];
  return stop.routes.slice(0, 7);
}

function stopCurve(data, stop, strategy = state.strategy) {
  const inputs = modelInputs();
  const scenario = state.scenarios.get(strategy);
  const routes = stopRouteIds(stop);
  const riderCounts = [];
  const probabilities = [];
  for (let bin = 0; bin < BIN_COUNT; bin += 1) {
    let totalRiders = 0;
    let paidWeighted = 0;
    for (const routeId of routes) {
      const riders = expectedBoardings(data, routeId, stop.id, bin);
      totalRiders += riders;
      paidWeighted += riders * getProbability(data, scenario, routeId, stop.id, bin, state.day, minuteForBin(bin), inputs.baseline);
    }
    riderCounts.push(totalRiders);
    probabilities.push(totalRiders > 0 ? paidWeighted / totalRiders : inputs.baseline);
  }
  return { riderCounts, probabilities, routes };
}

function aggregateStopStats(data, stop, bin) {
  const scenario = state.scenarios.get(state.strategy);
  const inputs = modelInputs();
  const routes = stopRouteIds(stop);
  let riders = 0;
  let probabilityTotal = 0;
  for (const routeId of routes) {
    const count = expectedBoardings(data, routeId, stop.id, bin);
    const probability = getProbability(data, scenario, routeId, stop.id, bin, state.day, state.minute, inputs.baseline);
    riders += count;
    probabilityTotal += count * probability;
  }
  return { riders, probability: riders ? probabilityTotal / riders : inputs.baseline };
}

function eventsThroughNow(scenario) {
  return (scenario?.schedule[state.day] || []).filter((event) => event.minute <= state.minute);
}

function currentMarkers(data, scenario) {
  if (!scenario || state.strategy === "none") return [];
  const allJourneys = scenario.journeysByDay[state.day] || [];
  const offShift = state.minute < SHIFT_START_MINUTE || state.minute > SHIFT_START_MINUTE + TEAM_HOURS * 60;
  return Array.from({ length: scenario.teamCount || 0 }, (_, team) => {
    const journeys = allJourneys.filter((item) => item.team === team).sort((a, b) => a.boardMinute - b.boardMinute);
    if (!journeys.length) return null;
    const first = journeys[0];
    const last = journeys[journeys.length - 1];
    const journey = journeys.find((item) => state.minute >= item.boardMinute && state.minute <= item.alightMinute);
    let location; let route; let status;
    if (state.minute < first.boardMinute) {
      location = stopCoordinate(data, first.boardStopId); route = data.routeById.get(first.routeId); status = "Shift start";
    } else if (state.minute > last.alightMinute) {
      location = stopCoordinate(data, last.alightStopId); route = data.routeById.get(last.routeId); status = "Shift end";
    } else if (!journey) {
      const previous = journeys.filter((item) => item.alightMinute < state.minute).at(-1);
      const next = journeys.find((item) => item.boardMinute > state.minute);
      const anchor = previous || next || first;
      location = previous ? stopCoordinate(data, previous.alightStopId) : stopCoordinate(data, anchor.boardStopId);
      route = data.routeById.get(anchor.routeId); status = offShift ? "Off shift" : "Waiting or transferring";
    } else {
      route = data.routeById.get(journey.routeId);
      location = interpolateJourney(data, journey, state.minute);
      const inspection = (scenario.schedule[state.day] || []).find((event) => event.journeyId === journey.id && state.minute >= event.minute && state.minute <= event.minute + CHECK_MINUTES);
      status = inspection ? "Checking" : "Riding";
    }
    if (!route || !location) return null;
    return { team, route, location, journey, inspecting: status === "Checking", offShift, line: route.short, status };
  }).filter(Boolean);
}

function stopCoordinate(data, stopId) {
  const stop = data.stopById.get(stopId);
  return stop ? [stop.lon, stop.lat] : null;
}

function interpolateJourney(data, journey, minute) {
  const stops = journey.stops;
  let left = journey.boardIndex;
  while (left < journey.alightIndex - 1 && stops[left + 1][1] <= minute) left += 1;
  const right = Math.min(journey.alightIndex, left + 1);
  const a = data.stopById.get(stops[left][0]);
  const b = data.stopById.get(stops[right][0]);
  if (!a) return b ? [b.lon, b.lat] : null;
  if (!b) return [a.lon, a.lat];
  const departure = stops[left][2] ?? stops[left][1];
  const duration = Math.max(1, stops[right][1] - departure);
  const mix = clamp((minute - departure) / duration, 0, 1);
  return [a.lon + (b.lon - a.lon) * mix, a.lat + (b.lat - a.lat) * mix];
}

function svgElement(name, attrs = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function getVisibleRouteIds(data) {
  if (state.focusRouteId !== "all") return new Set([state.focusRouteId]);
  const ids = data.routes.slice(0, 30).map((route) => route.id);
  const stop = data.stopById.get(state.selectedStopId);
  for (const routeId of stop?.routes.slice(0, 3) || []) ids.push(routeId);
  return new Set(ids);
}

function renderMap(data) {
  const svg = el("cityMap");
  const rect = svg.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 80) return;
  svg.replaceChildren();
  const width = rect.width;
  const height = rect.height;
  const roadsFeature = { type: "FeatureCollection", features: data.roads.flatMap((road) => road.lines.map((coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }))) };
  const features = [...roadsFeature.features];
  for (const route of data.routes) {
    for (const coordinates of route.geometry) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } });
  }
  const collection = { type: "FeatureCollection", features };
  const projection = geoMercator().fitExtent([[34, 30], [width - 32, height - 24]], collection);
  const path = geoPath(projection);
  state.projection = projection;
  state.mapPath = path;
  const streets = svgElement("g", { class: "streets" });
  for (const feature of roadsFeature.features) {
    streets.appendChild(svgElement("path", { d: path(feature) }));
  }
  svg.appendChild(streets);

  const visibleRoutes = getVisibleRouteIds(data);
  const baseline = modelInputs().baseline;
  el("mapLegendLabel").textContent = `Change from baseline · ${Math.round(baseline * 100)}%`;
  const routeGroup = svgElement("g", { class: "routes" });
  for (const route of data.routes) {
    if (!visibleRoutes.has(route.id)) continue;
    for (const coordinates of route.geometry) {
      const routePath = svgElement("path", {
        d: path({ type: "LineString", coordinates }),
        class: state.focusRouteId === route.id ? "is-focused" : (state.focusRouteId !== "all" ? "" : "is-context"),
        "data-route-id": route.id,
      });
      if (state.focusRouteId !== "all") routePath.classList.add("is-focused");
      else if (route.weekdayBoardings >= 20_000) routePath.classList.add("is-context");
      routeGroup.appendChild(routePath);
    }
  }
  svg.appendChild(routeGroup);

  if (state.focusRouteId === "all") {
    const routeLabels = svgElement("g", { class: "route-labels" });
    for (const route of data.routes.slice(0, 13)) {
      const line = route.geometry[0];
      if (!line?.length) continue;
      const point = projection(line[Math.floor(line.length * 0.58)]);
      if (point) routeLabels.appendChild(svgElement("text", { x: point[0] + 3, y: point[1] - 3 }, route.short));
    }
    svg.appendChild(routeLabels);
  }

  const selectedBin = binForMinute(state.minute);
  const visibleStops = data.stops.filter((stop) => stop.routes.some((routeId) => visibleRoutes.has(routeId)));
  const stopGroup = svgElement("g", { class: "stops" });
  for (const stop of visibleStops) {
    const point = projection([stop.lon, stop.lat]);
    if (!point) continue;
    const stats = aggregateStopStats(data, stop, selectedBin);
    const delta = stats.probability - baseline;
    const deltaText = changeLabel(stats.probability, baseline);
    const group = svgElement("g", { class: `stop-group${Math.abs(delta) >= 0.005 ? " has-change" : ""}${stop.id === state.selectedStopId ? " is-selected" : ""}`, transform: `translate(${point[0]},${point[1]})`, role: "button", "aria-label": `${stop.name}; ${Math.round(stats.probability * 100)} percent modeled chance to pay; ${deltaText}`, "data-stop-id": stop.id });
    group.appendChild(svgElement("circle", { class: "stop-hit", r: 10 }));
    if (Math.abs(delta) >= 0.005) {
      const ringRadius = 5.5 + Math.min(3, Math.abs(delta) * 10);
      group.appendChild(svgElement("circle", { class: "stop-change-ring", r: ringRadius, stroke: colorForProbability(stats.probability, baseline) }));
    }
    const dotRadius = (stop.id === state.selectedStopId ? 4.1 : 2.5) + Math.min(1.1, Math.abs(delta) * 4);
    group.appendChild(svgElement("circle", { class: "stop-mark", r: dotRadius, fill: colorForProbability(stats.probability, baseline) }));
    group.appendChild(svgElement("title", {}, `${stop.name}\n${Math.round(stats.probability * 100)}% modeled payment chance · ${deltaText} · ${timeLabel(state.minute)}`));
    group.addEventListener("click", () => {
      state.selectedStopId = stop.id;
      if (state.focusRouteId !== "all" && !stop.routes.includes(state.focusRouteId)) state.focusRouteId = "all";
      render();
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        state.selectedStopId = stop.id;
        render();
      }
    });
    stopGroup.appendChild(group);
  }
  svg.appendChild(stopGroup);

  const markers = currentMarkers(data, state.scenarios.get(state.strategy));
  const markerGroup = svgElement("g", { class: "team-markers" });
  for (const marker of markers) {
    if (marker.journey) {
      const coordinates = marker.journey.stops
        .slice(marker.journey.boardIndex, marker.journey.alightIndex + 1)
        .map(([stopId]) => data.stopById.get(stopId))
        .filter(Boolean)
        .map((stop) => [stop.lon, stop.lat]);
      if (coordinates.length > 1) markerGroup.appendChild(svgElement("path", { d: path({ type: "LineString", coordinates }), class: "team-trace" }));
    }
    const [x, y] = projection(marker.location);
    const group = svgElement("g", { class: "team-marker", transform: `translate(${x},${y})` });
    group.appendChild(svgElement("circle", { r: 12, fill: "#fffaf0", opacity: ".92" }));
    group.appendChild(svgElement("text", { class: "star", x: -8, y: 8 }, "★"));
    const markerStatus = marker.status === "Riding" || marker.status === "Checking"
      ? `${marker.status} · line ${marker.line}`
      : marker.status;
    group.appendChild(svgElement("text", { class: "team-label", x: 11, y: -8 }, `Team ${marker.team + 1} · ${markerStatus}`));
    markerGroup.appendChild(group);
  }
  svg.appendChild(markerGroup);
  el("mapLoading").hidden = true;
}

function renderStopChart(data) {
  const svg = el("stopChart");
  const box = svg.getBoundingClientRect();
  const width = box.width || 300;
  const height = box.height || 204;
  const stop = data.stopById.get(state.selectedStopId);
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  if (!stop) return;
  const series = stopCurve(data, stop);
  const left = 43;
  const right = width - 10;
  const top = 8;
  const topBottom = Math.round(height * 0.43);
  const lowerTop = Math.round(height * 0.57);
  const lowerBottom = height - 29;
  const x = (bin) => left + (right - left) * bin / (BIN_COUNT - 1);
  const maxRiders = Math.max(10, Math.ceil(Math.max(...series.riderCounts) / 10) * 10);
  const yRiders = (value) => topBottom - (value / maxRiders) * (topBottom - top - 8);
  const yProb = (value) => lowerBottom - value * (lowerBottom - lowerTop);

  for (const fraction of [0, 0.5, 1]) {
    const y1 = topBottom - fraction * (topBottom - top - 8);
    const y2 = lowerBottom - fraction * (lowerBottom - lowerTop);
    svg.appendChild(svgElement("line", { class: "chart-grid", x1: left, x2: right, y1, y2: y1 }));
    svg.appendChild(svgElement("line", { class: "chart-grid", x1: left, x2: right, y1: y2, y2 }));
    svg.appendChild(svgElement("text", { class: "chart-axis", x: left - 6, y: y1 + 3, "text-anchor": "end" }, fraction === 0 ? "0" : formatNumber(maxRiders * fraction)));
    svg.appendChild(svgElement("text", { class: "chart-axis", x: left - 6, y: y2 + 3, "text-anchor": "end" }, `${Math.round(fraction * 100)}%`));
  }
  const riderLine = series.riderCounts.map((value, index) => `${index ? "L" : "M"}${x(index)},${yRiders(value)}`).join(" ");
  const area = `${riderLine} L${x(BIN_COUNT - 1)},${topBottom} L${x(0)},${topBottom} Z`;
  const probLine = series.probabilities.map((value, index) => `${index ? "L" : "M"}${x(index)},${yProb(value)}`).join(" ");
  svg.appendChild(svgElement("path", { class: "curve-area", d: area }));
  svg.appendChild(svgElement("path", { class: "curve-riders", d: riderLine }));
  svg.appendChild(svgElement("path", { class: "curve-probability", d: probLine }));

  const selectedBin = binForMinute(state.minute);
  const guideX = x(selectedBin);
  svg.appendChild(svgElement("line", { class: "current-guide", x1: guideX, x2: guideX, y1: top, y2: lowerBottom }));
  svg.appendChild(svgElement("circle", { class: "curve-point", cx: guideX, cy: yRiders(series.riderCounts[selectedBin]), r: 3.5, fill: "#3978b8" }));
  svg.appendChild(svgElement("circle", { class: "curve-point", cx: guideX, cy: yProb(series.probabilities[selectedBin]), r: 3.5, fill: "#dc8b5b" }));

  const ticks = [0, Math.round((9 * 60 - START_MINUTE) / 15), Math.round((13 * 60 - START_MINUTE) / 15), Math.round((17 * 60 - START_MINUTE) / 15), BIN_COUNT - 1];
  for (const tick of [...new Set(ticks)]) {
    svg.appendChild(svgElement("line", { class: "chart-grid", x1: x(tick), x2: x(tick), y1: lowerBottom + 3, y2: lowerBottom + 6 }));
    svg.appendChild(svgElement("text", { class: "chart-axis", x: x(tick), y: height - 5, "text-anchor": tick === 0 ? "start" : tick === BIN_COUNT - 1 ? "end" : "middle" }, tick === BIN_COUNT - 1 ? "11:45p" : timeLabel(minuteForBin(tick), true)));
  }
  const hit = svgElement("rect", { class: "chart-hit", x: left, y: top, width: right - left, height: lowerBottom - top, "aria-hidden": "true" });
  hit.addEventListener("click", (event) => {
    const bounds = svg.getBoundingClientRect();
    const relativeX = event.clientX - bounds.left;
    const ratio = clamp((relativeX - left) / (right - left), 0, 1);
    state.minute = minuteForBin(Math.round(ratio * (BIN_COUNT - 1)));
    el("timeSlider").value = String(state.minute);
    render();
  });
  svg.appendChild(hit);
}

function getRiderForSelection(data) {
  const stop = data.stopById.get(state.selectedStopId);
  if (!stop) return null;
  const routes = stopRouteIds(stop);
  const bin = binForMinute(state.minute);
  for (const routeId of routes) {
    const cohort = state.scenarios.get(state.strategy)?.cohortByKey.get(cohortKeyFor(stop.id, routeId, bin));
    if (cohort) return cohort;
  }
  return null;
}

function renderRider(data) {
  const cohort = getRiderForSelection(data);
  const select = el("riderSelect");
  if (!select.options.length) {
    for (let index = 0; index < RIDER_SAMPLE_SIZE; index += 1) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `Synthetic rider ${String(index + 1).padStart(2, "0")}`;
      select.appendChild(option);
    }
    select.value = "6";
  }
  if (!cohort) {
    el("cohortRiderCount").textContent = "50";
    el("riderTitle").textContent = "Sample rider · frequent rider";
    el("riderHistory").textContent = "No inspection exposure at this stop and time yet";
    el("riderProbability").textContent = `${Math.round(modelInputs().baseline * 100)}%`;
    return;
  }
  const riderId = Number(select.value || 6);
  const rider = cohort.riders[riderId];
  if (!rider) return;
  const inputs = modelInputs();
  const observations = rider.observations.filter((item) => item.day < state.day || (item.day === state.day && item.minute <= state.minute));
  let boost = 0;
  let personal = 0;
  for (const observation of observations) {
    const elapsed = Math.max(0, state.day - observation.day);
    const decay = Math.exp(-inputs.decayRate * elapsed);
    boost += inputs.visibleLift * (observation.crossRoute ? inputs.routeCarryover : 1) * observation.impactScale * decay;
    if (observation.direct) personal += inputs.directLift * observation.impactScale * decay;
  }
  const probability = Math.min(1, rider.baseline + boost + personal);
  const directCount = observations.filter((item) => item.direct).length;
  const seenCount = observations.filter((item) => item.visible).length;
  const crossRouteCount = observations.filter((item) => item.crossRoute).length;
  const last = observations[observations.length - 1];
  const history = seenCount || crossRouteCount
    ? `${seenCount} seen · ${crossRouteCount} cross-route memory · ${directCount} personal check${directCount === 1 ? "" : "s"}${last ? ` · last day ${last.day}` : ""}`
    : "No inspection exposure at this stop and time yet";
  el("cohortRiderCount").textContent = String(RIDER_SAMPLE_SIZE);
  el("riderAvatar").textContent = String(riderId + 1).padStart(2, "0");
  el("riderTitle").textContent = `Rider ${String(riderId + 1).padStart(2, "0")} · frequent rider`;
  el("riderHistory").textContent = history;
  el("riderProbability").textContent = `${Math.round(probability * 100)}%`;
}

function renderStopDetails(data) {
  const stop = data.stopById.get(state.selectedStopId);
  if (!stop) return;
  el("selectedStopName").textContent = stop.name;
  const routeIds = stop.routes.slice(0, 4);
  el("selectedStopLines").textContent = routeIds.map((routeId) => data.routeById.get(routeId)?.short).filter(Boolean).join(" · ") || "—";
  el("lineFocusButton").setAttribute("aria-pressed", String(state.focusRouteId !== "all"));
  const selectedLine = state.focusRouteId === "all" ? "All" : data.routeById.get(state.focusRouteId)?.short || "All";
  el("lineFocusButton").querySelector("span").textContent = selectedLine;
  el("lineSelect").value = state.focusRouteId;
  el("selectedCohortTime").textContent = timeLabel(state.minute);
  const bin = binForMinute(state.minute);
  const stats = aggregateStopStats(data, stop, bin);
  el("selectedRiders").textContent = formatNumber(stats.riders);
  el("selectedChance").textContent = `${Math.round(stats.probability * 100)}%`;
  el("selectedChange").textContent = changeLabel(stats.probability, modelInputs().baseline);
  renderRider(data);

  const route = data.routeById.get(state.focusRouteId !== "all" ? state.focusRouteId : routeIds[0]);
  const routeScenario = state.scenarios.get(state.strategy);
  const lineGross = routeScenario?.routeRevenue.get(route?.id) || 0;
  el("lineStats").innerHTML = `
    <div class="line-stat"><span>Average weekday boardings</span><b>${formatNumber(route?.weekdayBoardings || 0)}</b><small>Route average</small></div>
    <div class="line-stat"><span>Modeled 90-day fare gain</span><b>${formatMoney(lineGross, true)}</b><small>Current strategy</small></div>`;
  const ranking = [...data.routes].map((item) => ({ route: item, gross: routeScenario?.routeRevenue.get(item.id) || 0 })).sort((a, b) => b.gross - a.gross).slice(0, 5);
  el("lineRanking").innerHTML = ranking.map((item) => `<div class="rank-row"><div class="rank-name"><span class="route-chip">${escapeHtml(item.route.short)}</span><span>${escapeHtml(item.route.name)}</span></div><span class="rank-vol">${formatNumber(item.route.weekdayBoardings)} / day</span><span class="rank-net">${formatMoney(item.gross, true)}</span></div>`).join("");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function renderComparison(data) {
  if (!state.modelReady) {
    el("comparisonTeamLabel").textContent = "Preparing the 90-day model";
    el("comparisonRows").innerHTML = '<tr><td colspan="8">Calculating strategy results…</td></tr>';
    el("staffingRecommendation").textContent = "Calculating team break-even…";
    el("staffingRows").innerHTML = '<tr><td colspan="4">Calculating marginal value per team…</td></tr>';
    el("annualProjection").textContent = "Annual run rate: calculating…";
    for (const id of ["nowChecked", "nowCitations", "nowExposed", "nowPayChance", "nowFare", "nowFineRevenue"]) el(id).textContent = "—";
    el("nowTeams").textContent = "—";
    el("nowTeamsStatus").textContent = "Preparing inspection teams…";
    return;
  }
  const inputs = modelInputs();
  const annualBaseline = FARE_BENCHMARK;
  el("comparisonTeamLabel").textContent = `${state.teamCount} ${state.teamCount === 1 ? "team" : "teams"} · same rider population`;
  el("comparisonRows").innerHTML = STRATEGIES.map((strategy) => {
    const scenario = state.scenarios.get(strategy.id);
    if (!scenario) return `<tr><td class="strategy-name-cell">${escapeHtml(strategy.label)}<span>${escapeHtml(strategy.sub)}</span></td><td colspan="7">${state.analyticsRunning ? "Calculating…" : "Available when you open the comparison"}</td></tr>`;
    const checked = scenario?.allEvents.reduce((sum, event) => sum + (event.day <= DAY_COUNT ? event.checkedCount : 0), 0) || 0;
    const exposed = scenario?.allEvents.reduce((sum, event) => sum + event.visibleCount, 0) || 0;
    const current = state.strategy === strategy.id ? " is-current" : "";
    const netClass = scenario?.net90 < 0 ? " negative" : "";
    return `<tr class="${current}"><td class="strategy-name-cell">${escapeHtml(strategy.label)}<span>${escapeHtml(strategy.sub)}</span></td><td>${formatNumber(checked)}</td><td>${formatNumber(exposed)}</td><td>${formatNumber(scenario?.expectedCitations90 || 0)}</td><td class="money">${formatMoney(scenario?.gross90 || 0, true)}</td><td class="money">${formatMoney(scenario?.collectedFines90 || 0, true)}</td><td class="cost">${formatMoney(scenario?.costs90 || 0, true)}</td><td class="money${netClass}">${formatMoney(scenario?.net90 || 0, true)}</td></tr>`;
  }).join("");
  const selected = state.scenarios.get(state.strategy);
  const events = eventsThroughNow(selected);
  const checks = events.reduce((sum, event) => sum + event.checkedCount, 0);
  const exposure = events.reduce((sum, event) => sum + event.visibleCount, 0);
  const citations = events.reduce((sum, event) => sum + event.expectedCitations, 0);
  const finesToNow = citations * inputs.fineAmount * inputs.fineCollectionRate;
  const active = currentMarkers(data, selected);
  const todayToNow = selected?.cashflowByDay[state.day].slice(0, binForMinute(state.minute) + 1).reduce((sum, item) => sum + item, 0) || 0;
  const annualProjection = selected ? Math.round(selected.annualNet) : 0;
  const fullYearSummary = `${formatMoney(annualProjection, true)} projected annual net`;
  el("nowTeams").textContent = `${active.length} ${active.length === 1 ? "team" : "teams"}`;
  el("nowTeamsStatus").textContent = active[0] ? `${active[0].status.toLowerCase()} · line ${active[0].line}` : "not deployed";
  el("nowChecked").textContent = formatNumber(checks);
  el("nowCitations").textContent = formatNumber(citations);
  el("nowExposed").textContent = formatNumber(exposure);
  const selectedStats = aggregateStopStats(data, data.stopById.get(state.selectedStopId), binForMinute(state.minute));
  el("nowPayChance").textContent = `${Math.round(selectedStats.probability * 100)}%`;
  el("nowPayChange").textContent = `${changeLabel(selectedStats.probability, modelInputs().baseline)} · selected stop`;
  el("nowFare").textContent = formatMoney(todayToNow, true);
  el("nowFineRevenue").textContent = formatMoney(finesToNow, true);
  el("nowFare").setAttribute("aria-label", `${formatMoney(todayToNow)} incremental fare revenue today to the selected time; ${fullYearSummary}`);
  el("dayValue").textContent = String(state.day);
  el("daySlider").value = String(state.day);
  el("timeValue").textContent = timeLabel(state.minute);
  el("timeSlider").value = String(state.minute);
    el("strategySelect").value = state.strategy;
  el("comparisonRows").setAttribute("aria-label", `Strategies compare 90-day checks, exposure, expected citations, incremental fares, collected fines, prorated inspector cost and net return. Historical annual baseline fare revenue was ${formatMoney(annualBaseline)}.`);
  const breakEvenRow = state.staffingCurve.find((row) => row.marginalNet <= 0);
  el("staffingRecommendation").textContent = !state.analyticsReady
    ? state.analyticsRunning ? "Calculating marginal value per team…" : "Open the strategy comparison to calculate staffing break-even."
    : state.staffingLimitReached
    ? `All ${MAX_INSPECTORS} tested teams remain positive; ${MAX_INSPECTORS} is only a lower bound on break-even.`
    : breakEvenRow
      ? `${breakEvenRow.inspectors - 1} team${breakEvenRow.inspectors - 1 === 1 ? "" : "s"} is the modeled revenue-maximizing staffing level; team ${breakEvenRow.inspectors} falls below break-even.`
      : "No team has positive modeled marginal net at the current assumptions; comparison uses zero teams.";
  el("staffingRows").innerHTML = !state.analyticsReady
    ? '<tr><td colspan="4">Staffing analysis runs when you open the comparison.</td></tr>'
    : state.staffingCurve.map((row) => {
    const isRecommended = state.staffingLimitReached
      ? row.inspectors === state.teamCount
      : row.inspectors === state.teamCount + 1;
    const marginalClass = row.marginalNet < 0 ? "below-zero" : "above-zero";
    const rowClass = `${isRecommended ? "recommended " : ""}${row.marginalNet <= 0 ? "negative" : ""}`;
    return `<tr class="${rowClass}"><td>Team ${row.inspectors}</td><td class="money">${formatMoney(row.addedAnnualGross, true)}</td><td class="cost">${formatMoney(row.annualCost, true)}</td><td class="${marginalClass}">${formatMoney(row.marginalNet, true)}</td></tr>`;
  }).join("");
  el("annualProjection").textContent = selected
    ? `Annual run rate: ${formatMoney(selected.annualFareGross, true)} fares + ${formatMoney(selected.annualFineGross, true)} fines − ${formatMoney(selected.annualCost, true)} inspector = ${formatMoney(annualProjection, true)} net / year`
    : "Annual run rate from 90 days: —";
}

function renderAssumptions() {
  const inputs = modelInputs();
  const halfLife = Math.log(2) / inputs.decayRate;
  el("baselineLabel").textContent = `${Math.round(inputs.baseline * 100)}%`;
  el("visibleLiftLabel").textContent = `+${Math.round(inputs.visibleLift * 100)} pp`;
  el("visibleLiftLabelNote").textContent = el("visibleLiftLabel").textContent;
  el("directLiftLabel").textContent = `+${Math.round(inputs.directLift * 100)} pp`;
  el("directLiftNote").textContent = el("directLiftLabel").textContent;
  el("rateLabel").textContent = String(inputs.checksPerMinute);
  el("citationRateLabel").textContent = `${Math.round(inputs.citationRate * 100)}%`;
  el("fineLabel").textContent = formatMoney(inputs.fineAmount);
  el("collectionLabel").textContent = `${Math.round(inputs.fineCollectionRate * 100)}%`;
  el("spreadLabel").textContent = `${inputs.timeSpread} min`;
  el("decayLabel").textContent = `${Number(halfLife.toFixed(1))} days`;
  el("staffCostLabel").textContent = formatMoney(inputs.teamAnnualCost);
  el("fareLabel").textContent = formatMoney(inputs.fare, false, 2);
  el("coveredFareShareLabel").textContent = `${Math.round(inputs.coveredFareShare * 100)}%`;
  el("discountFareShareLabel").textContent = `${Math.round(inputs.discountFareShare * 100)}%`;
  el("temperatureLabel").textContent = `${Math.round(inputs.temperature * 100)}%`;
  el("routeCarryoverLabel").textContent = `${Math.round(inputs.routeCarryover * 100)}%`;
}

function render() {
  if (!state.map) return;
  renderAssumptions();
  renderMap(state.map);
  renderStopDetails(state.map);
  renderStopChart(state.map);
  renderComparison(state.map);
}

function updateModel() {
  if (!state.map) return;
  if (state.simBusy) {
    state.pendingModelUpdate = true;
    return;
  }
  state.simBusy = true;
  el("mapLoading").hidden = false;
  el("mapLoading").textContent = "Simulating coordinated inspection teams…";
  requestAnimationFrame(() => {
    const inputs = modelInputs();
    const staffing = calculateStaffingCurve(state.map, inputs);
    state.teamCount = staffing.recommended;
    state.staffingCurve = staffing.curve;
    state.staffingLimitReached = staffing.limitReached;
    for (const strategy of STRATEGIES) {
      const cached = strategy.id === "busiest" ? staffing.scenarios.get(state.teamCount) : null;
      state.scenarios.set(strategy.id, cached || buildScenario(state.map, strategy.id, inputs, strategy.id === "none" ? 0 : state.teamCount));
    }
    state.analyticsReady = true;
    state.analyticsRunning = false;
    state.modelReady = true;
    state.simBusy = false;
    el("mapLoading").hidden = true;
    el("mapLoading").classList.remove("is-progress");
    render();
    if (state.pendingModelUpdate) {
      state.pendingModelUpdate = false;
      updateModel();
    }
  });
}

function calculateExpandedModel() {
  if (!state.map || state.analyticsReady || state.analyticsRunning) return;
  state.analyticsRunning = true;
  el("mapLoading").classList.add("is-progress");
  el("mapLoading").textContent = "Comparing strategies and staffing…";
  el("mapLoading").hidden = false;
  requestAnimationFrame(() => {
    const inputs = modelInputs();
    const staffing = calculateStaffingCurve(state.map, inputs);
    state.teamCount = staffing.recommended;
    state.staffingCurve = staffing.curve;
    state.staffingLimitReached = staffing.limitReached;
    for (const strategy of STRATEGIES) {
      const cached = strategy.id === "busiest" ? staffing.scenarios.get(state.teamCount) : null;
      state.scenarios.set(strategy.id, cached || buildScenario(state.map, strategy.id, inputs, strategy.id === "none" ? 0 : state.teamCount));
    }
    state.analyticsReady = true;
    state.analyticsRunning = false;
    el("mapLoading").hidden = true;
    el("mapLoading").classList.remove("is-progress");
    render();
  });
}

function setPlayState(playing) {
  state.playing = playing;
  const button = el("playButton");
  button.setAttribute("aria-pressed", String(playing));
  button.setAttribute("aria-label", playing ? "Pause simulation" : "Play simulation");
  button.querySelector(".play-icon").textContent = playing ? "Ⅱ" : "▶";
  button.querySelector(".play-label").textContent = playing ? "Pause" : "Play";
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  if (playing) {
    state.timer = setInterval(() => {
      const speed = Number(el("speedSelect").value);
      state.minute += PLAY_STEP_MINUTES * speed;
      if (state.minute > END_MINUTE) {
        state.minute = START_MINUTE;
        state.day += 1;
      }
      if (state.day > DAY_COUNT) {
        state.day = DAY_COUNT;
        state.minute = END_MINUTE;
        setPlayState(false);
      }
      render();
    }, 600);
  }
}

function populateRoutePicker(data) {
  const select = el("lineSelect");
  const fragment = document.createDocumentFragment();
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All lines";
  fragment.appendChild(all);
  for (const route of data.routes) {
    const option = document.createElement("option");
    option.value = route.id;
    option.textContent = `${route.short} · ${route.name.replace(/^\S+\s*/, "")}`;
    fragment.appendChild(option);
  }
  select.replaceChildren(fragment);
}

function chooseInitialStop(data) {
  const coreRoutes = new Set(data.routes.slice(0, 26).map((route) => route.id));
  const eligible = data.stops.filter((stop) => stop.routes.some((routeId) => coreRoutes.has(routeId)));
  const target = [37.776, -122.419];
  eligible.sort((a, b) => (a.lat - target[0]) ** 2 + (a.lon - target[1]) ** 2 - ((b.lat - target[0]) ** 2 + (b.lon - target[1]) ** 2));
  state.selectedStopId = eligible[0]?.id || data.stops[0]?.id || null;
}

function attachHandlers() {
  el("strategySelect").addEventListener("change", (event) => {
    state.strategy = event.target.value;
    if (state.modelReady && !state.scenarios.has(state.strategy)) {
      const strategy = STRATEGIES.find((item) => item.id === state.strategy);
      const scenario = buildScenario(state.map, state.strategy, modelInputs(), strategy?.id === "none" ? 0 : state.teamCount);
      state.scenarios.set(state.strategy, scenario);
    }
    render();
  });
  el("daySlider").addEventListener("input", (event) => { state.day = Number(event.target.value); render(); });
  el("timeSlider").addEventListener("input", (event) => { state.minute = Number(event.target.value); render(); });
  el("playButton").addEventListener("click", () => setPlayState(!state.playing));
  el("lineFocusButton").addEventListener("click", () => {
    const stop = state.map.stopById.get(state.selectedStopId);
    if (state.focusRouteId !== "all") state.focusRouteId = "all";
    else state.focusRouteId = stop?.routes[0] || "all";
    render();
  });
  el("lineSelect").addEventListener("change", (event) => {
    state.focusRouteId = event.target.value;
    if (state.focusRouteId !== "all") {
      const route = state.map.routeById.get(state.focusRouteId);
      const current = state.map.stopById.get(state.selectedStopId);
      if (!current?.routes.includes(state.focusRouteId)) {
        const stops = (state.map.stopsByRoute.get(state.focusRouteId) || []).filter(Boolean);
        const target = [37.776, -122.419];
        stops.sort((a, b) => (a.lat - target[0]) ** 2 + (a.lon - target[1]) ** 2 - ((b.lat - target[0]) ** 2 + (b.lon - target[1]) ** 2));
        state.selectedStopId = stops[0]?.id || state.selectedStopId;
      }
      if (!route) state.focusRouteId = "all";
    }
    render();
  });
  el("riderSelect").addEventListener("change", () => renderRider(state.map));
  for (const id of ["baselineInput", "visibleLiftInput", "directLiftInput", "rateInput", "citationRateInput", "fineInput", "collectionInput", "spreadInput", "decayInput", "staffCostInput", "fareInput", "temperatureInput", "routeCarryoverInput", "coveredFareShareInput", "discountFareShareInput"]) {
    el(id).addEventListener("input", updateModel);
    el(id).addEventListener("change", updateModel);
  }
  window.addEventListener("resize", () => renderMap(state.map));
}

async function init() {
  attachHandlers();
  try {
    const dataBase = `${import.meta.env.BASE_URL}data/`;
    const mapPromise = fetch(`${dataBase}muni-map.json`);
    const schedulePromise = fetch(`${dataBase}muni-schedule.json`);
    const mapResponse = await mapPromise;
    if (!mapResponse.ok) throw new Error(`Map data could not load (${mapResponse.status})`);
    const mapData = await mapResponse.json();
    mapData.schedule = { trips: [] };
    state.map = buildDataIndex(mapData);
    populateRoutePicker(state.map);
    chooseInitialStop(state.map);
    render();
    el("mapLoading").classList.add("is-progress");
    el("mapLoading").textContent = "Map ready · preparing inspection model…";
    el("mapLoading").hidden = false;
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    const scheduleResponse = await schedulePromise;
    if (!scheduleResponse.ok) throw new Error(`GTFS schedule data could not load (${scheduleResponse.status})`);
    mapData.schedule = await scheduleResponse.json();
    state.map = buildDataIndex(mapData);
    populateRoutePicker(state.map);
    chooseInitialStop(state.map);
    const inputs = modelInputs();
    state.teamCount = 1;
    state.scenarios.set("busiest", buildScenario(state.map, "busiest", inputs, state.teamCount));
    state.modelReady = true;
    const inspection = state.scenarios.get(state.strategy)?.schedule[state.day]
      ?.filter((event) => event.minute <= state.minute)
      .sort((a, b) => Math.abs(a.minute - state.minute) - Math.abs(b.minute - state.minute))[0];
    if (inspection?.stopId) state.selectedStopId = inspection.stopId;
    render();
    el("mapLoading").classList.remove("is-progress");
    const comparisonObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        comparisonObserver.disconnect();
        calculateExpandedModel();
      }
    }, { rootMargin: "0px" });
    comparisonObserver.observe(el("comparisonSection"));
    const resizeObserver = new ResizeObserver(() => renderMap(state.map));
    resizeObserver.observe(el("cityMap").parentElement);
  } catch (error) {
    el("mapLoading").textContent = `Simulation data could not be loaded: ${error.message}`;
    el("mapLoading").hidden = false;
    console.error(error);
  }
}

init();
