import L from 'leaflet';
import { findCoordinates, validQuery } from './geocode.mjs';
window.L = L;
require('leaflet.markercluster');

const svg = (content) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + content + '</svg>';
const icons = {
  search:svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>'),
  close:svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  refresh:svg('<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>'),
  pin:svg('<path d="M20 10c0 5-8 10-8 10S4 15 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>'),
  train:svg('<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 11h14M9 18l-2 3m8-3 2 3"/><circle cx="9" cy="14.5" r=".6"/><circle cx="15" cy="14.5" r=".6"/>'),
  time:svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>'),
  copy:svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10"/>'),
  route:svg('<path d="M7 5h8a3.5 3.5 0 1 1 0 7H9a3.5 3.5 0 1 0 0 7h8"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/>'),
};
const $ = (id) => document.getElementById(id);
const statusName = {active:'Действует',moved:'Переехало',closed:'Закрыто',planned:'Планируется переезд',review:'Уточнить статус'};
const filterLabels = {all:'Все',active:'Действующие',moved:'Переехавшие',closed:'Закрытые',planned:'Планируется',review:'Уточнить'};
const statusOrder = ['active','moved','planned','review','closed'];
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replaceAll('ё','е')
  .replace(/[^а-яa-z0-9]+/g,' ').trim();
const searchTerms = (s) => norm(s).split(' ').filter((t) => t && !['ул','улица','д','дом','м','метро','г','город','ло'].includes(t));
const hasNumber = (s) => /\d/.test(s);
const locale = new Intl.Collator('ru');
const time = new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'});
const mobile = matchMedia('(max-width:750px)');
const storageKey = 'mgkl-snapshot-v2';
const addressCache = new Map();
const state = {entries:[], sorted:[], indexed:[], stations:[], results:[], status:'all', type:'',
  origin:null, detailId:null, suggestions:[], focused:-1, geocodeSerial:0, lastData:null, tileUrl:null};
let map, tiles, cluster, originMarker, toastTimer, tileTimer;
let markers = new Map();

for (const [id,name] of Object.entries({'search-icon':'search','clear':'close','refresh':'refresh'})) $(id).innerHTML = icons[name];

function el(tag, cls, content) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (content !== undefined) element.textContent = content;
  return element;
}

function button(cls, label, action, icon) {
  const node = el('button',cls);
  node.type = 'button';
  if (icon) node.innerHTML = icons[icon];
  node.append(el('span','',label));
  node.addEventListener('click',action);
  return node;
}

function badge(status) {
  return el('span','status '+status,statusName[status]);
}

function formatDistance(km) {
  return km < 1 ? Math.round(km*1000) + ' м' : new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(km) + ' км';
}

function kmBetween(a,b) {
  const r = Math.PI/180;
  const h = Math.sin((a[0]-b[0])*r/2)**2 + Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin((a[1]-b[1])*r/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(h)));
}

function oneEdit(a,b) {
  if (Math.abs(a.length-b.length)>1) return false;
  if (a.length>b.length) return oneEdit(b,a);
  let i=0;
  while (i<a.length && a[i]===b[i]) i++;
  if (i===a.length) return true;
  if (a.length!==b.length) return a.slice(i)===b.slice(i+1);
  return a.slice(i+1)===b.slice(i+1) ||
    (a[i]===b[i+1] && a[i+1]===b[i] && a.slice(i+2)===b.slice(i+2));
}

function rankFields(fields, query) {
  const terms = searchTerms(query);
  if (!terms.length) return 0;
  let best = Infinity;
  for (const [phrase, words, weight] of fields) {
    if (phrase === norm(query)) best = Math.min(best,weight);
    else if (phrase.includes(norm(query))) best = Math.min(best,weight+2);
    else {
      const ranks = terms.map((q) => {
        if (words.includes(q)) return 0;
        if (words.some((word) => word.startsWith(q))) return 3;
        if (q.length >= 4 && !hasNumber(q) && words.some((word) => !hasNumber(word) && (oneEdit(q,word) || oneEdit(q,word.slice(0,q.length))))) return 8;
        return Infinity;
      });
      best = Math.min(best,weight+4+ranks.reduce((a,b) => a+b,0));
    }
  }
  return best;
}

const field = (value,weight) => [norm(value),searchTerms(value),weight];
const shown = (item) => (state.type === '' || item.type === state.type) &&
  (state.status === 'all' || item.status === state.status);

function computeResults() {
  const query = $('search').value.trim();
  if (state.origin) return state.sorted.filter((item) => item.status==='active' && item.point && shown(item))
    .map((item) => ({item, distance:kmBetween(item.point,state.origin.point)}))
    .sort((a,b) => a.distance-b.distance).slice(0,10);
  return state.indexed.filter(({item}) => shown(item))
    .map(({item,fields}) => ({item, score:rankFields(fields,query)}))
    .filter(({score}) => score!==Infinity).sort((a,b) => a.score-b.score);
}

function renderFilters() {
  const counts = Object.fromEntries(Object.keys(statusName).map((status) => [status,0]));
  for (const item of state.entries) if (!state.type || state.type===item.type) counts[item.status]++;
  const statuses = ['all','active','moved','closed',...['planned','review'].filter((s) => counts[s] || state.status===s)];
  counts.all = Object.values(counts).reduce((a,b) => a+b,0);
  for (const old of $('filters').children) old.dataset.existing = 'true';
  for (const status of statuses) {
    let chip = $('filters').querySelector('[data-filter="'+status+'"]');
    if (!chip) {
      chip = button('filter',filterLabels[status],() => {
        state.status = status;
        showResults();
        render();
        hideSuggestions();
      });
      chip.dataset.filter = status;
      chip.append(el('small'));
      $('filters').append(chip);
    }
    chip.dataset.existing = 'false';
    chip.setAttribute('aria-pressed',String(state.status===status));
    chip.lastChild.textContent = counts[status];
  }
  $('filters').querySelectorAll('[data-existing="true"]').forEach((chip) => chip.remove());
}

function resultRow(item, distance) {
  const row = el('button','result');
  row.type = 'button';
  row.dataset.branch = item.id;
  if (state.detailId === item.id) row.classList.add('selected');
  const title = el('span','result-title');
  title.append(el('span','result-name',item.name),badge(item.status));
  row.append(title);
  if (item.address) row.append(el('span','result-address',item.address));
  const meta = el('span','result-meta');
  for (const [value,icon] of [[distance===undefined ? '' : formatDistance(distance),'pin'],[item.metro,'train'],[item.hours,'time']]) {
    if (!value) continue;
    const atom = el('span');
    atom.innerHTML = icons[icon];
    atom.append(document.createTextNode(value));
    meta.append(atom);
  }
  if (meta.children.length) row.append(meta);
  row.addEventListener('click',() => select(item.id));
  return row;
}

function render() {
  renderFilters();
  state.results = computeResults();
  $('list-label').textContent = (state.origin ? 'Ближайшие · ' : 'Найдено · ') + state.results.length;
  $('results').replaceChildren(...state.results.map(({item,distance}) => resultRow(item,distance)));
  if (!state.results.length) {
    const box = el('div','empty');
    box.append(el('strong','',state.entries.length ? 'По этому запросу ничего не найдено' : 'Справочник загружается'));
    if (state.entries.length) box.append(el('p','',state.origin
      ? 'Проверь фильтры. Для расчёта нужны координаты действующих отделений.'
      : 'Попробуй часть названия или уточни адрес в поиске по карте.'));
    $('results').append(box);
  }
  updateMarkers();
}

function hideSuggestions() {
  $('suggestions').hidden = true;
  $('search').setAttribute('aria-expanded','false');
  $('search').removeAttribute('aria-activedescendant');
  state.focused = -1;
}
function stationOptions(query) {
  const options = state.stations.map((s) => ({...s,score:rankFields([s.field],query)}))
    .filter((s) => s.score < Infinity).sort((a,b) => a.score-b.score);
  const unique = [];
  for (const s of options) {
    if (!unique.some((x) => norm(x.name)===norm(s.name) && kmBetween(x.point,s.point)<0.75)) unique.push(s);
  }
  return unique;
}
function showSuggestions() {
  const query = $('search').value.trim();
  const suggestions = $('suggestions');
  if (query.length<2 || state.origin) {
    hideSuggestions();
    return;
  }
  const stations = stationOptions(query).slice(0,3);
  const branches = state.results.slice(0,stations.length ? 3 : 6);
  state.suggestions = [
    ...stations.map((s) => ({title:s.name, description:s.line+' · ближайшие отделения', icon:'train', chosen:() => chooseOrigin(s)})),
    ...branches.map(({item}) => ({title:item.name, description:item.address, icon:'pin', chosen:() => select(item.id)})),
    ...(query.length >= 4 ? [{title:'Найти адрес на карте',description:query,icon:'search',chosen:() => lookup(query)}] : []),
  ];
  const options = state.suggestions.map((s,index) => {
    const row = suggestionRow(s.title,s.description,s.icon,s.chosen);
    row.id = 'suggestion-'+index;
    row.setAttribute('role','option');
    row.setAttribute('aria-selected','false');
    row.addEventListener('mousedown',(event) => event.preventDefault());
    return row;
  });
  suggestions.replaceChildren(...options);
  state.focused = -1;
  suggestions.hidden = !options.length;
  $('search').setAttribute('aria-expanded',String(Boolean(options.length)));
}
function suggestionRow(title,description,icon,chosen) {
  const row = button('suggest','',chosen,icon);
  row.lastChild.textContent = title;
  if (description) row.lastChild.append(el('small','',description));
  return row;
}

function showResults() {
  state.detailId = null;
  $('details').hidden = true;
  $('list-area').hidden = false;
  $('list-area').scrollTop = 0;
}
function setView(mode) {
  document.body.classList.toggle('show-map',mode==='map');
  $('map-tab').setAttribute('aria-pressed',String(mode==='map'));
  $('list-tab').setAttribute('aria-pressed',String(mode==='list'));
  if (mode==='map' && map) {
    requestAnimationFrame(() => {
      map.invalidateSize();
      if (state.detailId) centerPoint(state.entries.find((x) => x.id===state.detailId)?.point);
      else if (state.origin) fit(state.results.map(({item}) => item.point).concat([state.origin.point]));
      else fit([...markers.values()].map((m) => m.getLatLng()));
    });
  }
}

function select(id) {
  const item = state.entries.find((entry) => entry.id===id);
  if (!item) return;
  hideSuggestions();
  state.detailId = id;
  renderDetails(item);
  updateMarkers();
  if (mobile.matches) setView('list');
  centerPoint(item.point);
}

function toRoute(item, point) {
  const url = new URL('https://yandex.ru/maps/');
  const regionAddress = /москва|московская|люберцы|подольск|химки|мытищи|сапроново|видное|мисайлово|котельники|электросталь|зеленоград|жуковский|домодедово/i.test(item.address)
    ? item.address : 'Москва, '+item.address;
  url.searchParams.set('rtext',(point ? point.join(',') : '')+'~'+(item.point ? item.point.join(',') : regionAddress));
  return url.href;
}

function history(item, visited = new Set(), depth = 0) {
  if (visited.has(item.id) || depth>8) return [];
  const path = new Set(visited).add(item.id);
  const steps = item.steps.filter((s) => s.category || !item.steps.some((x) => x.category && (x.id ? x.id===s.id : x.name===s.name)));
  return steps.flatMap((s) => {
    const target = s.id && state.entries.find(({id}) => id===s.id);
    const details = target && target.status==='moved' && !steps.some((later) => target.steps.some((next) =>
      later !== s && later.id && later.id === next.id && (later.date === next.date || !next.date)));
    return [s,...(details ? history(target,path,depth+1) : [])];
  }).filter((s,i,all) => !all.slice(0,i).some((x) => x.name===s.name && x.date===s.date && x.category===s.category));
}

function renderDetails(item) {
  const details = $('details');
  const nav = el('div','detail-nav');
  nav.append(button('back','К списку',() => {showResults();render();$('search').focus();}));
  nav.append(badge(item.status));
  const title = el('h2','detail-title',item.name);
  const fields = el('dl','fields');
  const fieldPairs = [[item.status==='moved' || item.status==='closed' ? 'Прежний адрес' : 'Адрес',item.address],
    ['Метро / ж. д.',item.metro],['Режим работы',item.hours],['Тип',item.type]];
  if (item.date && ['moved','planned'].includes(item.status)) fieldPairs.push(['Дата переезда',item.date]);
  for (const [name,value] of fieldPairs) {
    if (!value) continue;
    const field = el('div');
    field.append(el('dt','',name),el('dd','',value));
    fields.append(field);
  }
  const actions = el('div','detail-actions');
  if (item.address) actions.append(button('action','Скопировать адрес',() => copy(item.address,'Адрес скопирован'),'copy'));
  const steps = history(item);
  actions.append(button('action','Скопировать информацию',() => {
    copy([item.name,statusName[item.status],...fieldPairs.filter(([,value]) => value).map(([n,v]) => n+' — '+v),
      ...steps.map((s) => [s.date,s.category,s.name,s.address].filter(Boolean).join(' · '))].join('\n'),'Информация скопирована');
  },'copy'));
  if (item.address && item.status==='active') {
    const route = el('a','action primary-action');
    route.innerHTML = icons.route;
    route.append(el('span','','Построить маршрут'));
    route.href = toRoute(item,state.origin?.point);
    route.target = '_blank';
    route.rel = 'noopener noreferrer';
    actions.append(route);
  }
  details.replaceChildren(nav,title);
  if (item.goldLetterRequired) {
    details.append(el('p','gold-letter-notice','По золоту нужно написать письмо'));
  }
  const goodsMoves = item.status==='moved' && steps.some((step) => /техник|мехов/i.test(step.category));
  if (!goodsMoves) details.append(fields,actions);
  if (steps.length) {
    const moves = el('section',goodsMoves ? 'history goods-history' : 'history');
    const heading = goodsMoves ? 'Куда переехали залоги'
      : item.status==='planned' ? 'Куда планируется переезд' : 'История переезда';
    moves.append(el('h3','',heading));
    for (const s of steps) {
      const step = el('div','step');
      const note = [s.date,s.category].filter(Boolean).join(' · ');
      if (note) step.append(el('div','step-note',note));
      step.append(el('span','step-heading',s.name));
      if (s.address) step.append(el('p','',s.address));
      if (s.id) step.append(button('text-action','Открыть карточку',() => select(s.id)));
      moves.append(step);
    }
    details.append(moves);
  }
  if (goodsMoves) details.append(fields,actions);
  if (item.status==='review') details.append(el('p','empty','В таблице требуется уточнить статус отделения.'));
  if (item.address) {
    const extra = el('div','nearby-action');
    if (!item.point && item.status==='active') extra.append(el('p','step-note','Для этого адреса нет проверенной точки на карте.'));
    extra.append(button('text-action','Ближайшие к этому адресу',() => {
      state.status = 'all';
      if (item.point) chooseOrigin({name:item.address,point:item.point});
      else {
        showResults();
        $('search').value = item.address.replace(/\s+/g,' ');
        render();
        lookup($('search').value);
      }
    }));
    if (item.point && mobile.matches) extra.append(el('br'),button('text-action','Показать на карте',() => setView('map')));
    details.append(extra);
  }
  $('list-area').hidden = true;
  details.hidden = false;
  details.scrollTop = 0;
  details.querySelector('button').focus({preventScroll:true});
}

async function copy(text, success) {
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(text);
    else {
      const field = el('textarea');
      field.value=text;
      document.body.append(field);
      field.select();
      const ok = document.execCommand('copy');
      field.remove();
      if (!ok) throw new Error();
    }
    toast(success);
  } catch {
    toast('Буфер обмена недоступен');
  }
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => {$('toast').hidden = true;},2500);
}

function chooseOrigin(origin) {
  state.origin = origin;
  $('search').value = origin.name;
  $('clear').hidden = false;
  $('geocode-results').hidden = true;
  hideSuggestions();
  showResults();
  render();
  fit(state.results.map(({item}) => item.point).concat([origin.point]));
}

async function lookup(query) {
  query = query.trim();
  if (query.length<4) return;
  const serial = ++state.geocodeSerial;
  showResults();
  hideSuggestions();
  const box = $('geocode-results');
  box.hidden = false;
  box.replaceChildren(el('p','','Ищем адрес на карте…'));
  const submit = $('search-form').querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    if (!validQuery(query)) throw new Error('Уточни улицу или адрес дома.');
    let candidates = addressCache.get(query.toLowerCase());
    if (!candidates) {
      candidates = await findCoordinates(query).catch(() => {
        throw new Error('Поиск по карте временно недоступен. Поиск по справочнику работает.');
      });
      if (addressCache.size >= 100) addressCache.delete(addressCache.keys().next().value);
      addressCache.set(query.toLowerCase(),candidates);
    }
    if (serial!==state.geocodeSerial) return;
    const eligible = candidates.filter((item) => !hasNumber(query) || item.precision==='house');
    if (!eligible.length) {
      box.replaceChildren(el('p','','Адрес не найден. Укажи населённый пункт, улицу и номер дома.'));
      return;
    }
    box.replaceChildren(el('p','','Выбери точку для поиска ближайших отделений'),
      ...eligible.map((c) => suggestionRow(c.name,c.locality+(c.precision==='street' ? ' · точка улицы' : ''),'pin',() => chooseOrigin(c))));
  } catch (error) {
    if (serial===state.geocodeSerial) box.replaceChildren(el('p','',error.message || 'Карта временно недоступна.'));
  } finally {
    if (serial===state.geocodeSerial) submit.disabled = false;
  }
}

function resetInput() {
  state.origin = null;
  state.geocodeSerial++;
  $('search-form').querySelector('[type="submit"]').disabled = false;
  $('clear').hidden = !$('search').value;
  $('geocode-results').hidden = true;
  showResults();
  render();
}

function buildMap(tileUrl) {
  if (map) return;
  map = L.map('map',{zoomControl:false,scrollWheelZoom:true}).setView([55.751,37.62],10);
  map.attributionControl.setPrefix(false);
  L.control.zoom({position:'bottomright',zoomInTitle:'Приблизить',zoomOutTitle:'Отдалить'}).addTo(map);
  tiles = L.tileLayer(tileUrl,{
    maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" lang="en">OpenStreetMap</a>',
    referrerPolicy:'strict-origin-when-cross-origin',
  }).addTo(map);
  tiles.on('tileerror',() => {
    clearTimeout(tileTimer);
    tileTimer = setTimeout(() => {$('map-error').hidden = false;},1200);
  });
  tiles.on('tileload',() => {clearTimeout(tileTimer);$('map-error').hidden = true;});
  cluster = L.markerClusterGroup({
    showCoverageOnHover:false,maxClusterRadius:49,
    iconCreateFunction:(c) => L.divIcon({
      className:'cluster-icon',iconSize:[38,38],html:'<span class="cluster-count">'+c.getChildCount()+'</span>',
    }),
  }).addTo(map);
}
function pin(selected=false, origin=false) {
  return L.divIcon({
    className:'pin-icon',iconSize:[34,34],iconAnchor:[17,17],
    html:'<span class="map-pin '+(origin ? 'origin' : selected ? 'selected' : '')+'">'+(origin ? '' : icons.pin)+'</span>',
  });
}
function updateMarkers() {
  if (!map) return;
  const items = state.results.map(({item}) => item).filter((item) => item.status==='active');
  const selected = state.entries.find((entry) => entry.id===state.detailId);
  if (selected?.status==='active' && !items.some(({id}) => id===selected.id)) items.push(selected);
  const wanted = new Map(items.filter((item) => item.point).map((item) => [item.id,item]));
  for (const [id,marker] of markers) {
    if (!wanted.has(id)) {
      cluster.removeLayer(marker);
      markers.delete(id);
    }
  }
  for (const [id,item] of wanted) {
    const active = id===state.detailId;
    let marker = markers.get(id);
    if (!marker) {
      marker = L.marker(item.point,{icon:pin(active),title:item.name,alt:item.name});
      const tip = el('span','',item.name);
      marker.bindTooltip(tip,{className:'branch-tooltip',direction:'top',offset:[0,-10]});
      marker.on('click',() => select(id));
      marker.selected = active;
      markers.set(id,marker);
      cluster.addLayer(marker);
    } else {
      if (!marker.getLatLng().equals(item.point)) {
        cluster.removeLayer(marker);
        marker.setLatLng(item.point);
        cluster.addLayer(marker);
      }
      if (marker.selected!==active) {
        marker.setIcon(pin(active));
        marker.selected = active;
      }
      marker.getTooltip().getContent().textContent = item.name;
    }
  }
  if (originMarker) map.removeLayer(originMarker);
  originMarker = state.origin ? L.marker(state.origin.point,{icon:pin(false,true),title:state.origin.name,zIndexOffset:1200}).addTo(map) : null;
  $('origin-key').hidden = !state.origin;
  $('map-title').textContent = state.origin ? 'Ближайшие к точке поиска' : 'Действующие отделения';
  const missing = items.filter((item) => !item.point).length;
  $('map-info').textContent = wanted.size+' на карте'+(missing ? ' · '+missing+' без проверенной точки' : '')+
    (state.origin ? ' · расстояние по прямой' : '');
}
function fit(points) {
  if (!map || !points.length || (mobile.matches && !$('map-panel').offsetWidth)) return;
  map.fitBounds(L.latLngBounds(points),{paddingTopLeft:[30,95],paddingBottomRight:[50,50],maxZoom:15,animate:false});
}
function centerPoint(point) {
  if (map && point && (!mobile.matches || $('map-panel').offsetWidth)) map.setView(point,16);
}
function resetMap() {
  if (!map) return;
  const points = [...markers.values()].map((m) => m.getLatLng());
  if (state.origin) points.push(state.origin.point);
  if (points.length) fit(points);
  else map.setView([55.751,37.62],10);
}

function ingest(data) {
  const previous = state.entries.find((item) => item.id===state.detailId);
  const first = !state.lastData;
  state.lastData = data;
  state.entries = data.entries;
  state.stations = data.stations.map((s) => ({...s,field:field(s.name,0)}));
  state.sorted = [...data.entries].sort((a,b) => statusOrder.indexOf(a.status)-statusOrder.indexOf(b.status)||locale.compare(a.name,b.name));
  state.indexed = state.sorted.map((item) => ({item,fields:[
    field(item.name,0),field(item.address,4),field(item.metro,2),
    ...item.steps.flatMap((s) => [field(s.name,12),field(s.address,14)]),
  ]}));
  const types = [...new Set(state.entries.map((item) => item.type))].sort(locale.compare);
  if (!types.includes(state.type)) state.type = '';
  $('branch-type').replaceChildren(...[['','Все типы'],...types.map((type) => [type,type])].map(([value,label]) => {
    const option = el('option','',label);
    option.value = value;
    return option;
  }));
  $('branch-type').value = state.type;
  if (previous) {
    const current = data.entries.find((item) => item.name===previous.name && item.address===previous.address && item.type===previous.type);
    if (current) {state.detailId=current.id;renderDetails(current);}
    else showResults();
  }
  buildMap(data.tileUrl);
  if (data.tileUrl !== state.tileUrl) tiles.setUrl(data.tileUrl);
  state.tileUrl=data.tileUrl;
  render();
  if (first) resetMap();
}

function syncLabel(data) {
  const sync = $('sync');
  sync.classList.toggle('stale',!data || data.stale);
  sync.replaceChildren(el('span','sync-dot'));
  const message = data ? (data.stale ? 'Данные из копии · ' : 'Обновлено · ')+time.format(Date.parse(data.updatedAt))+' МСК'
    : 'Таблица временно недоступна';
  sync.append(document.createTextNode(message));
}

let loading = false;
async function refresh() {
  if (loading) return;
  loading=true;
  $('refresh').disabled=true;
  try {
    const response = await fetch('./directory.json',{cache:'no-store',signal:AbortSignal.timeout(18000)});
    if (!response.ok) throw new Error();
    let data = await response.json();
    if (!data.entries?.length || !data.stations) throw new Error();
    data.stale = Date.now() - Date.parse(data.updatedAt) > 45 * 60_000;
    if (data.stale && state.lastData && Date.parse(state.lastData.updatedAt)>Date.parse(data.updatedAt))
      data={...state.lastData,stale:true};
    if (!state.lastData || data.updatedAt!==state.lastData.updatedAt) ingest(data);
    if (!data.stale) {
      try {localStorage.setItem(storageKey,JSON.stringify(data));} catch { /* offline caching is optional */ }
    }
    syncLabel(data);
  } catch {
    syncLabel(state.lastData ? {...state.lastData,stale:true} : null);
    if (!state.lastData) $('results').replaceChildren(el('p','empty','Нет сохранённой копии. Попробуй проверить обновления.'));
  } finally {
    loading=false;
    $('refresh').disabled=false;
  }
}

$('search').addEventListener('input',() => {resetInput();showSuggestions();});
$('search').addEventListener('focus',showSuggestions);
$('search').addEventListener('keydown',(event) => {
  if (event.key==='Escape') {hideSuggestions();return;}
  if (!['ArrowUp','ArrowDown'].includes(event.key) || $('suggestions').hidden) return;
  event.preventDefault();
  const options = [...$('suggestions').children];
  const delta = event.key==='ArrowDown' ? 1 : -1;
  state.focused=(state.focused<0 && delta<0) ? options.length-1 : (state.focused+delta+options.length)%options.length;
  options.forEach((row,i) => row.setAttribute('aria-selected',String(i===state.focused)));
  $('search').setAttribute('aria-activedescendant',options[state.focused].id);
  options[state.focused].scrollIntoView({block:'nearest'});
});
$('search-form').addEventListener('submit',(event) => {
  event.preventDefault();
  const query = $('search').value.trim();
  if (query.length<2) return;
  if (state.focused>=0 && !$('suggestions').hidden) {
    state.suggestions[state.focused]?.chosen();
    return;
  }
  const stations = stationOptions(query).filter((s) => norm(s.name)===norm(query.replace(/^м(?:етро)?[. ]+/i,'')));
  if (stations.length===1) {chooseOrigin(stations[0]);return;}
  if (stations.length>1) {showSuggestions();return;}
  const exact = state.results.filter(({item}) => norm(item.name)===norm(query) || norm(item.address)===norm(query));
  if (exact.length===1) {
    const item=exact[0].item;
    if (item.point && norm(item.address)===norm(query)) chooseOrigin({name:item.address,point:item.point});
    else select(item.id);
  } else if (hasNumber(query) || !state.results.length) lookup(query);
  else hideSuggestions();
});
$('clear').addEventListener('click',() => {$('search').value='';resetInput();hideSuggestions();$('search').focus();});
document.addEventListener('pointerdown',(event) => {if (!$('search-form').contains(event.target)) hideSuggestions();});
$('branch-type').addEventListener('change',() => {state.type=$('branch-type').value;showResults();render();});
$('reset-map').addEventListener('click',() => {
  $('search').value='';
  state.status='all';
  state.type='';
  $('branch-type').value='';
  resetInput();
  resetMap();
});
$('list-tab').addEventListener('click',() => setView('list'));
$('map-tab').addEventListener('click',() => setView('map'));
$('refresh').addEventListener('click',refresh);
mobile.addEventListener('change',() => {if (map) requestAnimationFrame(() => map.invalidateSize());});
document.addEventListener('visibilitychange',() => {if (document.visibilityState==='visible') refresh();});
try {
  const stored=JSON.parse(localStorage.getItem(storageKey) ?? 'null');
  if (stored?.entries?.length && stored.stations) {ingest(stored);syncLabel({...stored,stale:true});}
} catch { /* freshly load without the optional cache */ }
refresh();
setInterval(() => {if (document.visibilityState==='visible') refresh();},300_000);
