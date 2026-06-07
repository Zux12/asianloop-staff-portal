const $ = (id) => document.getElementById(id);

const loginBox = $('loginBox');
const attendanceBox = $('attendanceBox');
const loginMsg = $('loginMsg');
const attMsg = $('attMsg');

function showLogin(){
  loginBox.classList.remove('hidden');
  attendanceBox.classList.add('hidden');
}

function showAttendance(email){
  $('userEmail').textContent = email || '—';
  loginBox.classList.add('hidden');
  attendanceBox.classList.remove('hidden');
  loadToday();
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

checkSession();
