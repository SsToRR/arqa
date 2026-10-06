'use strict';
const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2}).format(Number(value)) + ' ₸';
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dialog = $('trip-dialog');
let selected = new URLSearchParams(location.search).get('date') || '2026-10-01';
if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || Number.isNaN(new Date(selected + 'T12:00:00Z').getTime())) selected = '2026-10-01';
let loadSequence = 0;
let saving = false;
let toastTimer;

function todayInKazakhstan() {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Qyzylorda',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function updateDate() {
  $('selected-date').value = selected;
  const date = new Date(selected + 'T12:00:00Z');
  $('date-caption').textContent = new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(date).replace(' г.','');
  const day = new Intl.DateTimeFormat('ru-RU',{weekday:'long',timeZone:'UTC'}).format(date);
  $('weekday').textContent = day[0].toUpperCase() + day.slice(1);
  $('today').setAttribute('aria-pressed', String(selected === todayInKazakhstan()));
  history.replaceState(null,'',`?date=${selected}`);
}

function notify(message) {
  clearTimeout(toastTimer);
  $('toast').querySelector('span').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden = true, 5000);
}

function duration(start,end) {
  const minutes = Math.round((new Date(end)-new Date(start))/60000);
  return minutes >= 60 ? `${Math.floor(minutes/60)} ч ${minutes%60} мин` : `${minutes} мин`;
}

function renderTrips(trips) {
  $('trip-count').textContent = trips.length;
  if (!trips.length) {
    $('trip-list').innerHTML = `<div class="list-state">${icon('car')}<h3>В этот день поездок пока нет</h3><p>Добавьте первую поездку, чтобы увидеть доходы и итоги смены.</p><button class="button secondary" id="empty-add">${icon('plus')}Добавить поездку</button></div>`;
    $('empty-add').addEventListener('click', openForm);
    return;
  }
  $('trip-list').innerHTML = trips.map((trip,index) => {
    const cash = trip.payment === 'cash';
    const start = trip.start.slice(11,16), end = trip.end.slice(11,16);
    const overnight = trip.start.slice(0,10) !== trip.end.slice(0,10);
    const endDate = new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(trip.end.slice(0,10)+'T12:00:00Z'));
    return `<article class="trip" aria-label="Поездка ${escapeHTML(trip.id)}"><span class="trip-number">${index+1}</span><div class="trip-time"><strong>${start}<span class="time-separator">→</span>${end}</strong><div class="trip-meta"><span>${duration(trip.start,trip.end)}</span><span class="trip-id" title="ID: ${escapeHTML(trip.id)}">ID: ${escapeHTML(trip.id)}</span>${overnight?`<span>до ${endDate}</span>`:''}</div></div><div class="trip-payment"><span class="payment-badge ${cash?'cash-badge':'card-badge'}">${icon(cash?'cash':'card')}${cash?'Наличные':'Карта'}</span></div><div class="trip-value trip-commission"><span>Комиссия</span><strong>${money(trip.commission)}</strong></div><div class="trip-value trip-net"><span>На руки</span><strong>${money(Number(trip.amount)-Number(trip.commission))}</strong></div><div class="trip-value trip-amount"><span>Сумма поездки</span><strong>${money(trip.amount)}</strong></div></article>`;
  }).join('');
}

async function loadDay() {
  const sequence = ++loadSequence;
  updateDate();
  $('trip-list').setAttribute('aria-busy','true');
  $('trip-list').innerHTML = '<div class="list-state">Загружаем поездки…</div>';
  $('trip-count').textContent = '—';
  ['trips','revenue','commission','net','cash','card'].forEach(key => $('metric-'+key).textContent = '—');
  $('result-net').textContent = '—';
  $('result-caption').textContent = 'Загружаем сводку…';
  try {
    const responses = await Promise.all([fetch(`/api/trips?date=${selected}`),fetch(`/api/summary?date=${selected}`)]);
    if (responses.some(r => !r.ok)) throw new Error('Не удалось загрузить день');
    const [trips,summary] = await Promise.all(responses.map(r => r.json()));
    if (sequence !== loadSequence) return;
    renderTrips(trips);
    ['trips','revenue','commission','net','cash','card'].forEach(key => $('metric-'+key).textContent = key==='trips'?summary[key]:money(summary[key]));
    $('result-net').textContent = money(summary.net);
    const totalMinutes = trips.reduce((n,t) => n+(new Date(t.end)-new Date(t.start))/60000,0);
    $('result-caption').textContent = trips.length ? `${trips.length} ${tripWord(trips.length)} · ${Math.floor(totalMinutes/60)?Math.floor(totalMinutes/60)+' ч ':''}${Math.round(totalMinutes%60)} мин в поездках` : 'Новая смена начинается с первой поездки.';
  } catch (error) {
    if (sequence !== loadSequence) return;
    $('trip-list').innerHTML = `<div class="list-state">${icon('info')}<h3>Не удалось загрузить поездки</h3><p>Проверьте соединение и попробуйте ещё раз.</p><button class="button secondary" id="retry">Повторить</button></div>`;
    $('retry').addEventListener('click',loadDay);
    $('result-caption').textContent = 'Сводка временно недоступна.';
  } finally {
    if (sequence === loadSequence) $('trip-list').setAttribute('aria-busy','false');
  }
}

function tripWord(n) {return n%100>=11&&n%100<=14?'поездок':n%10===1?'поездка':n%10>=2&&n%10<=4?'поездки':'поездок';}
function shiftDay(offset) {
  const date = new Date(selected+'T12:00:00Z');
  date.setUTCDate(date.getUTCDate()+offset);
  selected = date.toISOString().slice(0,10);
  loadDay();
}

function openForm() {
  if (dialog.open) return;
  $('trip-form').reset();
  $('form-error').hidden = true;
  document.querySelectorAll('[aria-invalid]').forEach(input=>input.removeAttribute('aria-invalid'));
  $('trip-id').value = 't-' + (crypto.randomUUID ? crypto.randomUUID().slice(0,8) : Date.now().toString(36));
  $('trip-start').value = `${selected}T10:00`;
  $('trip-end').value = `${selected}T10:30`;
  previewNet();
  dialog.showModal();
  dialog.querySelector('.form-body').scrollTop = 0;
  $('trip-start').focus();
}

function closeForm() {if (!saving) dialog.close();}
function previewNet() {$('form-net').textContent = money(Number($('trip-amount').value||0)-Number($('trip-commission').value||0));}
function showFormError(message,field) {
  $('form-error').textContent = message;
  $('form-error').hidden = false;
  if (field) {field.setAttribute('aria-invalid','true');field.focus();}
  $('form-error').scrollIntoView({block:'nearest'});
}

$('trip-form').addEventListener('submit',async event => {
  event.preventDefault();
  if (saving) return;
  $('form-error').hidden = true;
  document.querySelectorAll('[aria-invalid]').forEach(input=>input.removeAttribute('aria-invalid'));
  const id = $('trip-id').value.trim();
  if (!id) return showFormError('Укажите уникальный ID поездки.',$('trip-id'));
  const start = $('trip-start').value+':00+05:00';
  const end = $('trip-end').value+':00+05:00';
  if (new Date(end)<=new Date(start)) return showFormError('Окончание должно быть позже начала. Для ночной поездки выберите следующую дату.',$('trip-end'));
  const payload = {id,start,end,amount:$('trip-amount').value,commission:$('trip-commission').value,payment:new FormData($('trip-form')).get('payment')};
  saving = true;
  $('save-trip').disabled = true;
  $('save-trip').textContent = 'Сохраняем…';
  $('close-dialog').disabled = $('cancel-dialog').disabled = true;
  try {
    const response = await fetch('/api/trips',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const result = await response.json();
    if (!response.ok) {
      const fields = {id:$('trip-id'),start:$('trip-start'),end:$('trip-end'),amount:$('trip-amount'),commission:$('trip-commission')};
      const error = result.detail?.[0];
      const fieldName = error?.loc?.[1];
      const messages = {id:'Укажите ID поездки до 100 символов.',start:'Укажите корректную дату и время начала.',end:'Укажите корректную дату и время окончания.',amount:'Сумма должна быть больше нуля, не более 999 999 999 999,99 ₸, с точностью до двух знаков.',commission:'Комиссия должна быть неотрицательной, не более 999 999 999 999,99 ₸, с точностью до двух знаков.',payment:'Выберите наличные или карту.'};
      showFormError(messages[fieldName]||'Не удалось сохранить поездку. Проверьте введённые данные.',fields[fieldName]);
      return;
    }
    if (response.status===200) {
      showFormError(`Поездка с ID «${result.id}» уже есть в дневнике. Дубль не создан. Для новой поездки укажите другой ID.`,$('trip-id'));
      await loadDay();
      return;
    }
    selected = result.start.slice(0,10);
    dialog.close();
    await loadDay();
    notify('Поездка сохранена. Сводка обновлена.');
  } catch(error) {
    showFormError('Нет соединения с сервером. Повторите сохранение с тем же ID — дубль не появится.');
  } finally {
    saving = false;
    $('save-trip').disabled = false;
    $('close-dialog').disabled = $('cancel-dialog').disabled = false;
    $('save-trip').innerHTML = icon('check')+'Сохранить поездку';
  }
});

$('add-trip').addEventListener('click',openForm);
$('close-dialog').addEventListener('click',closeForm);
$('cancel-dialog').addEventListener('click',closeForm);
dialog.addEventListener('cancel',event => {if(saving) event.preventDefault();});
dialog.addEventListener('click',event => {if(event.target===dialog&&event.clientX<dialog.getBoundingClientRect().left) closeForm();});
$('trip-amount').addEventListener('input',previewNet);
$('trip-commission').addEventListener('input',previewNet);
$('trip-form').addEventListener('input',event=>{event.target.removeAttribute('aria-invalid');$('form-error').hidden=true;});
$('previous').addEventListener('click',()=>shiftDay(-1));
$('next').addEventListener('click',()=>shiftDay(1));
$('today').addEventListener('click',()=>{selected=todayInKazakhstan();loadDay();});
$('selected-date').addEventListener('change',()=>{if($('selected-date').value){selected=$('selected-date').value;loadDay();}});
document.querySelectorAll('.nav-link').forEach(link=>link.addEventListener('click',()=>{document.querySelectorAll('.nav-link').forEach(l=>l.classList.toggle('active',l===link));}));
loadDay();
