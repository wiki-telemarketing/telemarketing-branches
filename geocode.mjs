export const defaultGeocoder='https://photon.komoot.io/api/';

export function validQuery(query) {
  return query.length >= 4 && query.length <= 160 && /^[\p{L}\d ().,/'"\-–№]+$/u.test(query);
}

function pointFromFeature(feature) {
  const p = feature.properties ?? {};
  const [lng,lat] = feature.geometry?.coordinates ?? [];
  if (p.countrycode !== 'RU' || lat < 53.9 || lat > 57.0 || lng < 34.7 || lng > 41.2 ||
      !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!(p.housenumber && p.street) && p.type !== 'street') return null;
  return {
    name:[p.street ?? p.name,p.housenumber].filter(Boolean).join(', '),
    locality:[p.city ?? p.locality ?? p.county,p.district].filter(Boolean).join(', '),
    precision:p.housenumber ? 'house' : 'street',
    point:[lat,lng],
  };
}

export async function findCoordinates(query, endpoint=defaultGeocoder) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({q:query,limit:'10',lat:'55.75',lon:'37.62',bbox:'34.7,53.9,41.2,57.0'});
  const response = await fetch(url, {signal:AbortSignal.timeout(8500)});
  if (!response.ok) throw new Error('Geocoding unavailable');
  const features = (await response.json()).features ?? [];
  const candidates=[];
  for (const candidate of features.map(pointFromFeature).filter(Boolean)) {
    if (candidates.some((item) => item.name===candidate.name && item.locality===candidate.locality
      && Math.abs(item.point[0]-candidate.point[0]) < .001 && Math.abs(item.point[1]-candidate.point[1]) < .0015)) continue;
    candidates.push(candidate);
  }
  return candidates.slice(0,6);
}
