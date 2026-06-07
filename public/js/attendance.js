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

$('clockInBtn').addEventListener('click', async () => {
  attMsg.textContent = 'Getting GPS location...';

  try{
    const pos = await getPosition();

    const payload = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      reason: $('outsideReason').value || '',
      note: $('outsideNote').value || '',
      userAgent: navigator.userAgent || ''
    };

    const r = await fetch('/api/attendance/clock-in', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    const j = await r.json().catch(()=>({}));

    if(r.status === 409 && j.needReason){
      $('outsideBox').classList.remove('hidden');
      attMsg.textContent = j.error || 'You are outside office radius. Please select a reason and press Clock In again.';
      return;
    }

    if(!r.ok || !j.ok){
      attMsg.textContent = j.error || 'Clock-in failed.';
      return;
    }

    $('outsideBox').classList.add('hidden');
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
