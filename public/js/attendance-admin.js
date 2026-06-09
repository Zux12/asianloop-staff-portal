const $ = (id) => document.getElementById(id);

function getDistanceText(m){
  if(m === null || m === undefined) return '-';
  if(m >= 1000) return (m/1000).toFixed(2) + ' km';
  return Math.round(m) + ' m';
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

function initSelectors(){
  const months = [
    ['01','January'], ['02','February'], ['03','March'],
    ['04','April'], ['05','May'], ['06','June'],
    ['07','July'], ['08','August'], ['09','September'],
    ['10','October'], ['11','November'], ['12','December']
  ];

  $('adminMonth').innerHTML = months.map(m =>
    `<option value="${m[0]}">${m[1]}</option>`
  ).join('');

  const currentYear = new Date().getFullYear();
  let years = '';
  for(let y = currentYear; y >= currentYear - 3; y--){
    years += `<option value="${y}">${y}</option>`;
  }
  $('adminYear').innerHTML = years;

  $('adminMonth').value = String(new Date().getMonth() + 1).padStart(2, '0');
  $('adminYear').value = String(currentYear);

  $('adminMonth').addEventListener('change', loadAdmin);
  $('adminYear').addEventListener('change', loadAdmin);
}

function label(r){
  if(r.outsideReason === 'On Leave') return 'On Leave';
  if(r.status === 'OUTSIDE_GEOFENCE') return 'Outside Office';
  if(r.status === 'LATE') return 'Late';
  return 'On Time';
}

async function loadAdmin(){
  const month = $('adminMonth').value;
  const year = $('adminYear').value;

  const r = await fetch(`/api/attendance/admin?month=${month}&year=${year}`, {
    cache:'no-store'
  });

  const j = await r.json().catch(()=>({}));

  if(!r.ok || !j.ok){
    $('adminSummary').textContent = j.error || 'Unable to load records.';
    return;
  }

  const s = j.summary;

  $('adminSummary').innerHTML = `
    <strong>Monthly Attendance Summary</strong><br><br>
    Total Records: ${s.total || 0}<br>
    Office Attendance: ${s.officeAttendance || 0}<br>
    • On Time: ${s.onTime || 0}<br>
    • Late: ${s.late || 0}<br><br>
    Outside Office Attendance: ${s.outsideOffice || 0}<br>
    On Leave: ${s.onLeave || 0}
  `;

  if(!j.records.length){
    $('adminRecords').innerHTML = '<div class="record-card">No records found.</div>';
    return;
  }

$('adminRecords').innerHTML = j.records.map(r => {
  const loc = r.clockInLocation || {};
  const inside = loc.insideOffice ? 'Yes' : 'No';
  const accuracy = loc.accuracy ? Math.round(loc.accuracy) + ' m' : '-';

  return `
    <div class="record-card">
      <strong>${r.email}</strong>
      <div class="record-meta">
        Date: ${fmtDate(r.dateKey)}<br>
        Clock In: ${fmtTime(r.clockInAt)}<br>
        Clock Out: ${fmtTime(r.clockOutAt)}<br>
        Status: ${label(r)}<br>
        Distance: ${getDistanceText(loc.distanceM)}<br>
        GPS Accuracy: ${accuracy}<br>
        Inside Office: ${inside}<br>
        Reason: ${r.outsideReason || '-'}<br>
        Note: ${r.outsideNote || '-'}<br>
        Weekend: ${r.isWeekend ? 'Yes' : 'No'}<br>
        Device: ${r.userAgent || '-'}
      </div>
    </div>
  `;
}).join('');
}


function toggleList(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.toggle('hidden');
}

function personList(items){
  if(!items || !items.length) return '<div class="muted">None</div>';

  return items.map(x => {
    const name = x.name || x.email || '-';
    const email = x.email || '';
    return `<div>• ${name}${email && name !== email ? ' — ' + email : ''}</div>`;
  }).join('');
}

async function loadTodayStatus(){
  try{
    const r = await fetch('/api/attendance/admin/today-status', {
      cache:'no-store'
    });

    const j = await r.json().catch(()=>({}));

    if(!r.ok || !j.ok){
      document.getElementById('dailySummary').textContent =
        j.error || 'Unable to load today status.';
      return;
    }

    const s = j.summary;
    const lists = j.lists;

    document.getElementById('dailySummary').innerHTML = `
      <strong>Today’s Clock-In Status</strong><br><br>

      Active Staff: ${s.activeStaff}<br><br>

      <button class="mini-toggle" onclick="toggleList('clockedList')">
        ▶ Clocked In Today: ${s.clockedIn}
      </button>
      <div id="clockedList" class="hidden mini-list">
        ${personList(lists.clockedIn)}
      </div>

      <button class="mini-toggle" onclick="toggleList('notClockedList')">
        ▶ Not Clocked In Today: ${s.notClockedIn}
      </button>
      <div id="notClockedList" class="hidden mini-list">
        ${personList(lists.notClockedIn)}
      </div>

      <button class="mini-toggle" onclick="toggleList('leaveList')">
        ▶ On Leave Today: ${s.onLeave}
      </button>
      <div id="leaveList" class="hidden mini-list">
        ${personList(lists.onLeave)}
      </div>

      <div class="hint" style="margin-top:10px">
        Based on active staff in the staff directory.
      </div>
    `;
  }catch(e){
    document.getElementById('dailySummary').textContent =
      'Unable to load today status.';
  }
}

async function loadExportStaff(){
  try{
    const r = await fetch('/api/staff-basic', { cache:'no-store' });
    const staff = await r.json();

    const el = $('exportStaff');
    el.innerHTML = '<option value="all">All Staff</option>';

    if(Array.isArray(staff)){
      staff.forEach(s => {
        if(!s.email) return;
        const name = s.name || s.email;
        el.innerHTML += `<option value="${s.email}">${name} — ${s.email}</option>`;
      });
    }
  }catch(e){}
}

function downloadCsv(){
  const month = $('adminMonth').value;
  const year = $('adminYear').value;
  const email = $('exportStaff').value || 'all';

  const url =
    `/api/attendance/admin/export?month=${encodeURIComponent(month)}` +
    `&year=${encodeURIComponent(year)}` +
    `&email=${encodeURIComponent(email)}`;

  window.location.href = url;
}

$('downloadCsvBtn').addEventListener('click', downloadCsv);



initSelectors();
loadAdmin();
loadTodayStatus();
loadExportStaff();
