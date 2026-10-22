'use strict';
/**
 * The places and routes of the Julian demo seed (all around Seattle, WA). Coordinates are rough
 * ([lat, lng]): the router snaps each to the nearest road. `ROUTES` is what fetch-routes.js asks the
 * router for; a route id is used by the people in people.js, driven forward or (when no reverse route
 * is listed) back along the same road.
 */

const PLACES = {
  // Julian
  home: [47.6598, -122.3352], // Wallingford
  school: [47.677, -122.3157],
  job: [47.6633, -122.2992], // University Village
  friendA: [47.6925, -122.3555], // Greenwood
  friendB: [47.635, -122.281], // Madison Park
  target: [47.7072, -122.3276], // Northgate
  greenlake: [47.679, -122.3265],
  gasworks: [47.6456, -122.3344],
  goldengardens: [47.6906, -122.4026],
  alki: [47.5795, -122.4095],
  bellevue: [47.6162, -122.2025],
  redmond: [47.6741, -122.1215],
  issaquah: [47.542, -122.043],
  snoqualmie: [47.5412, -121.8374], // Snoqualmie Falls
  seatac: [47.4429, -122.301],
  tacoma: [47.2529, -122.4443],
  everett: [47.979, -122.2021],
  // friends
  homeMaya: [47.6685, -122.384], // Ballard
  uw: [47.6553, -122.3035],
  downtown: [47.6097, -122.3331],
  homeEthan: [47.683, -122.205], // Kirkland
  msft: [47.6396, -122.1283],
  seattleCenter: [47.6205, -122.3493],
  homePriya: [47.6228, -122.3185], // Capitol Hill
  homeMarcus: [47.4839, -122.2098], // Renton
  bellevueWork: [47.613, -122.192],
  southcenter: [47.462, -122.261],
  homeSofia: [47.7556, -122.3414], // Shoreline
  lynnwood: [47.8209, -122.3151],
  homeLiam: [47.651, -122.35], // Fremont
  homeOlivia: [47.685, -122.12], // Redmond
  woodinville: [47.7543, -122.1635],
};

/** [id, from, to, alternates] — the routes the router is asked for. */
const R = (id, from, to, alts = 0, via = []) => ({ id, from, to, alts, via });

const ROUTES = [
  // Julian's school run and after-school job, each way on its own roads, with a second way to go
  R('home_school', 'home', 'school', 1),
  R('school_home', 'school', 'home', 1),
  R('home_job', 'home', 'job'),
  R('job_home', 'job', 'home'),
  R('school_job', 'school', 'job'),
  R('home_friendA', 'home', 'friendA'),
  R('home_friendB', 'home', 'friendB'),
  R('home_target', 'home', 'target'),
  R('target_home', 'target', 'home'),
  R('home_greenlake', 'home', 'greenlake'),
  R('home_gasworks', 'home', 'gasworks'),
  R('home_goldengardens', 'home', 'goldengardens'),
  R('home_alki', 'home', 'alki'),
  R('alki_home', 'alki', 'home'),
  R('home_bellevue', 'home', 'bellevue'),
  R('bellevue_home', 'bellevue', 'home'),
  R('home_redmond', 'home', 'redmond'),
  R('home_issaquah', 'home', 'issaquah'),
  R('home_snoqualmie', 'home', 'snoqualmie'),
  R('snoqualmie_home', 'snoqualmie', 'home'),
  R('home_seatac', 'home', 'seatac'),
  R('home_tacoma', 'home', 'tacoma'),
  R('tacoma_home', 'tacoma', 'home'),
  R('home_everett', 'home', 'everett'),
  // friends
  R('maya_uw', 'homeMaya', 'uw'),
  R('maya_target', 'homeMaya', 'target'),
  R('maya_goldengardens', 'homeMaya', 'goldengardens'),
  R('maya_downtown', 'homeMaya', 'downtown'),
  R('ethan_msft', 'homeEthan', 'msft'),
  R('ethan_bellevue', 'homeEthan', 'bellevue'),
  R('ethan_seattleCenter', 'homeEthan', 'seattleCenter'),
  R('ethan_woodinville', 'homeEthan', 'woodinville'),
  R('priya_uw', 'homePriya', 'uw'),
  R('priya_downtown', 'homePriya', 'downtown'),
  R('priya_alki', 'homePriya', 'alki'),
  R('priya_seattleCenter', 'homePriya', 'seattleCenter'),
  R('marcus_bellevueWork', 'homeMarcus', 'bellevueWork'),
  R('marcus_southcenter', 'homeMarcus', 'southcenter'),
  R('marcus_seatac', 'homeMarcus', 'seatac'),
  R('marcus_tacoma', 'homeMarcus', 'tacoma'),
  R('sofia_target', 'homeSofia', 'target'),
  R('sofia_lynnwood', 'homeSofia', 'lynnwood'),
  R('sofia_greenlake', 'homeSofia', 'greenlake'),
  R('sofia_everett', 'homeSofia', 'everett'),
  R('liam_school', 'homeLiam', 'school'),
  R('liam_gasworks', 'homeLiam', 'gasworks'),
  R('olivia_redmond', 'homeOlivia', 'redmond'),
  R('olivia_bellevue', 'homeOlivia', 'bellevue'),
  R('olivia_woodinville', 'homeOlivia', 'woodinville'),
];

module.exports = { PLACES, ROUTES };
