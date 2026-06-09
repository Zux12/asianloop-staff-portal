const $ = (id) => document.getElementById(id);

const loginBox = $('loginBox');
const attendanceBox = $('attendanceBox');
const loginMsg = $('loginMsg');
const attMsg = $('attMsg');


function isMobileDevice(){
  const ua = navigator.userAgent || '';
  const hasTouch = navigator.maxTouchPoints && navigator.maxTouchPoints > 1;

  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || hasTouch;
}

function enforceMobileOnly(){
  if(isMobileDevice()) return true;

  $('clockInBtn').disabled = true;
  $('clockOutBtn').disabled = true;
  $('todayStatus').textContent = 'Attendance can only be used from a mobile phone.';
  $('gpsStatus').textContent = 'Please open this page from your handphone.';
  return false;
}


function showLogin(){
  loginBox.classList.remove('hidden');
  attendanceBox.classList.add('hidden');
}

function getDistanceText(m){
  if(m >= 1000){
    return (m/1000).toFixed(2) + ' km';
  }
  return Math.round(m) + ' m';
}


function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function updateGpsStatus(){

  try{

    const pos = await getPosition();

    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;

    const officeLat = 2.93527;
    const officeLng = 101.65530;

    const distance = haversineM(
      lat,
      lng,
      officeLat,
      officeLng
    );

    const txt = `
Distance from Office: ${getDistanceText(distance)}
GPS Accuracy: ${Math.round(pos.coords.accuracy)} m
`;

    $('gpsStatus').textContent = txt;

  } catch(e){

    $('gpsStatus').textContent =
      'GPS unavailable';

  }
}


function showAttendance(email){
  const cleanEmail = String(email || '').toLowerCase();

  $('userEmail').textContent = cleanEmail || '—';
  loginBox.classList.add('hidden');
  attendanceBox.classList.remove('hidden');

  const adminLink = $('adminAttendanceLink');
  if(adminLink){
    adminLink.classList.add('hidden');

    fetch('/api/attendance/is-admin', {
      cache:'no-store'
    })
    .then(r => r.json())
    .then(j => {
      if(j && j.isAdmin){
        adminLink.classList.remove('hidden');
      }
    })
    .catch(() => {});
  }

  if(!enforceMobileOnly()) return;

  loadToday();
  updateGpsStatus();
  initHistorySelectors();
  loadHistory();
}

async function checkSession(){
  try{
    const r = await fetch('/api/attendance/me', { cache:'no-store' });
    if(!r.ok) return showLogin();
    const j = await r.json();
    if(j && j.email) showAttendance(j.email);
    else showLogin();
  }catch(e){
    showLogin();
  }
}

$('loginBtn').addEventListener('click', async () => {
  loginMsg.textContent = '';

  const email = $('email').value.trim().toLowerCase();
  const password = $('password').value;

  if(!email || !password){
    loginMsg.textContent = 'Please enter email and password.';
    return;
  }

  try{
    const r = await fetch('/attendance-auth', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ email, password })
    });

    const j = await r.json().catch(()=>({}));

    if(!r.ok || !j.ok){
      loginMsg.textContent = j.error || 'Login failed.';
      return;
    }

    showAttendance(j.email);
  }catch(e){
    loginMsg.textContent = 'Login error. Please try again.';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/attendance-logout', { method:'POST' });
  showLogin();
});

async function loadToday(){
  try{
    const r = await fetch('/api/attendance/today', { cache:'no-store' });
    if(!r.ok){
      $('todayStatus').textContent = 'Unable to load attendance status.';
      return;
    }

    const j = await r.json();

    if(!j.record){
      $('todayStatus').textContent = 'Today: Not clocked in yet.';
      $('clockInBtn').disabled = false;
      $('clockOutBtn').disabled = true;
      return;
    }

    if(j.record.clockInAt && !j.record.clockOutAt){
      $('todayStatus').textContent = 'Today: Clocked in. Clock-out is optional for now.';
      $('clockInBtn').disabled = true;
      $('clockOutBtn').disabled = false;
      return;
    }

    if(j.record.clockInAt && j.record.clockOutAt){
      $('todayStatus').textContent = 'Today: Clocked in and clocked out.';
      $('clockInBtn').disabled = true;
      $('clockOutBtn').disabled = true;
      return;
    }
  }catch(e){
    $('todayStatus').textContent = 'Unable to load attendance status.';
  }
}

function getPosition(){
  return new Promise((resolve, reject) => {
    if(!navigator.geolocation){
      reject(new Error('GPS is not supported on this device/browser.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos),
      err => reject(err),
      {
        enableHighAccuracy:true,
        timeout:15000,
        maximumAge:0
      }
    );
  });
}

let outsideMode = false;
let lastPositionPayload = null;

function resetOutsideMode(){
  outsideMode = false;
  lastPositionPayload = null;
  $('outsideBox').classList.add('hidden');
  $('clockInBtn').textContent = 'Clock In';
  $('outsideReason').value = '';
  $('outsideNote').value = '';
}

$('cancelOutsideBtn').addEventListener('click', () => {
  resetOutsideMode();
  attMsg.textContent = '';
});

$('clockInBtn').addEventListener('click', async () => {
  attMsg.style.color = '#dc2626';

  try{
    let payload;

    if(outsideMode && lastPositionPayload){
      const reason = $('outsideReason').value || '';
      const note = $('outsideNote').value || '';

      if(!reason){
        attMsg.textContent = 'Please select a reason before submitting clock-in.';
        return;
      }

      if(reason === 'Other' && !note.trim()){
        attMsg.textContent = 'Please enter notes when selecting Other.';
        return;
      }

      payload = {
        ...lastPositionPayload,
        reason,
        note
      };

      attMsg.textContent = 'Submitting clock-in...';

    } else {
      attMsg.textContent = 'Getting GPS location...';

      const pos = await getPosition();

      payload = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        reason: '',
        note: '',
        userAgent: navigator.userAgent || ''
      };

      lastPositionPayload = payload;
    }

    const r = await fetch('/api/attendance/clock-in', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    const j = await r.json().catch(()=>({}));

    if(r.status === 409 && j.needReason){
      outsideMode = true;
      $('outsideBox').classList.remove('hidden');
      $('clockInBtn').textContent = 'Submit Clock In';

      if(j.distanceM){
        const km = (j.distanceM / 1000).toFixed(2);
        $('outsideText').textContent = `You are approximately ${km} km from the office. Please provide a reason.`;
      }

      attMsg.textContent = 'Please select a reason, then press Submit Clock In.';
      return;
    }

    if(!r.ok || !j.ok){
      attMsg.textContent = j.error || 'Clock-in failed.';
      return;
    }

    resetOutsideMode();
    attMsg.style.color = '#16a34a';
    attMsg.textContent = 'Clock-in successful.';
    await loadToday();

  }catch(e){
    attMsg.style.color = '#dc2626';
    attMsg.textContent = e.message || 'Unable to get GPS location.';
  }
});

$('clockOutBtn').addEventListener('click', async () => {
  attMsg.textContent = 'Getting GPS location...';

  try{
    const pos = await getPosition();

    const payload = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      userAgent: navigator.userAgent || ''
    };

    const r = await fetch('/api/attendance/clock-out', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    const j = await r.json().catch(()=>({}));

    if(!r.ok || !j.ok){
      attMsg.textContent = j.error || 'Clock-out failed.';
      return;
    }

    attMsg.style.color = '#16a34a';
    attMsg.textContent = 'Clock-out successful.';
    await loadToday();

  }catch(e){
    attMsg.style.color = '#dc2626';
    attMsg.textContent = e.message || 'Unable to get GPS location.';
  }
});


let recordsVisible = false;

function initHistorySelectors(){
  const monthEl = $('historyMonth');
  const yearEl = $('historyYear');

  const months = [
    ['01','January'], ['02','February'], ['03','March'],
    ['04','April'], ['05','May'], ['06','June'],
    ['07','July'], ['08','August'], ['09','September'],
    ['10','October'], ['11','November'], ['12','December']
  ];

  monthEl.innerHTML = months.map(m =>
    `<option value="${m[0]}">${m[1]}</option>`
  ).join('');

  const currentYear = new Date().getFullYear();
  let years = '';
  for(let y = currentYear; y >= currentYear - 3; y--){
    years += `<option value="${y}">${y}</option>`;
  }
  yearEl.innerHTML = years;

  monthEl.value = String(new Date().getMonth() + 1).padStart(2, '0');
  yearEl.value = String(currentYear);

  monthEl.addEventListener('change', loadHistory);
  yearEl.addEventListener('change', loadHistory);

  $('toggleRecordsBtn').addEventListener('click', () => {
    recordsVisible = !recordsVisible;
    $('historyRecords').classList.toggle('hidden', !recordsVisible);
    $('toggleRecordsBtn').textContent = recordsVisible
      ? 'Hide Attendance Records'
      : 'Show Attendance Records';
  });
}

function fmtDate(dateKey){
  const [y,m,d] = dateKey.split('-');
  return `${d}/${m}/${y}`;
}

function fmtTime(dt){
  if(!dt) return '-';
  return new Date(dt).toLocaleTimeString([], {
    hour:'2-digit',
    minute:'2-digit'
  });
}

function getRecordLabel(r){
  if(r.outsideReason === 'On Leave') return 'On Leave';
  if(r.status === 'OUTSIDE_GEOFENCE') return 'Outside Office';
  if(r.status === 'LATE') return 'Late';
  return 'On Time';
}

function getRecordDistance(r){
  const m = r?.clockInLocation?.distanceM;
  if(m === undefined || m === null) return '-';
  return getDistanceText(m);
}

async function loadHistory(){
  try{
    const month = $('historyMonth').value;
    const year = $('historyYear').value;

    const r = await fetch(`/api/attendance/history?month=${month}&year=${year}`, {
      cache:'no-store'
    });

    const j = await r.json();

    if(!r.ok || !j.ok){
      $('historySummary').textContent = 'Unable to load history.';
      return;
    }

    const s = j.summary || {};

    $('historySummary').innerHTML = `
      <strong>Monthly Clock-In Summary</strong><br><br>
      Total Clock-In Days: ${s.totalClockInDays || 0}<br><br>
      Office Attendance: ${s.officeAttendance || 0}<br>
      • On Time: ${s.onTime || 0}<br>
      • Late: ${s.late || 0}<br><br>
      Outside Office Attendance: ${s.outsideOffice || 0}<br><br>
      On Leave: ${s.onLeave || 0}
    `;

    const records = j.records || [];

    if(!records.length){
      $('historyRecords').innerHTML = '<div class="record-card">No records for this month.</div>';
      return;
    }

    $('historyRecords').innerHTML = records.map(r => {
      const reason = r.outsideReason ? `<br>Reason: ${r.outsideReason}` : '';
      const note = r.outsideNote ? `<br>Note: ${r.outsideNote}` : '';

      return `
        <div class="record-card">
          <strong>${fmtDate(r.dateKey)}</strong>
          <div class="record-meta">
            Clock In: ${fmtTime(r.clockInAt)}<br>
            Status: ${getRecordLabel(r)}<br>
            Distance: ${getRecordDistance(r)}
            ${reason}
            ${note}
          </div>
        </div>
      `;
    }).join('');

  }catch(e){
    $('historySummary').textContent = 'Unable to load history.';
  }
}

checkSession();
