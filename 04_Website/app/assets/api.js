/* ============================================================
   ResumeMatch PH — Service layer (assets/api.js)  v3
   ------------------------------------------------------------
   ONE surface, TWO adapters. Every method returns a Promise in
   BOTH modes, so flipping CONFIG.mode is genuinely free — no
   page code changes. (v2's demo adapter was synchronous, which
   meant switching to the PHP backend would have broken every
   page on the first call. Fixed here.)

     CONFIG.mode = 'demo'  → browser storage, zero setup
     CONFIG.mode = 'php'   → fetch() against the XAMPP backend

   The SERVER owns identity: the client never passes its own
   user id. The session decides who you are, so nobody can read
   someone else's data by editing a parameter.

   Matching rules (paper, Development and Testing — initial
   values, refined iteratively):
     skills 50% · education 25% · experience 25%
     strong >= 80  ·  related-role fallback < 50
   Statuses: submitted · review · shortlisted · rejected · hired
   ============================================================ */
(function (global) {
  'use strict';

  const CONFIG = {
    mode: 'demo',        // <-- flip to 'php' after following SETUP.md
    apiBase: '../api',   // relative to /app/*.html
  };

  const WEIGHTS       = { skills: 0.50, education: 0.25, experience: 0.25 };
  const THRESHOLDS    = { strong: 80, related: 50 };
  const STATUS_LABELS = { submitted:'Submitted', review:'Under review', shortlisted:'Shortlisted', rejected:'Not selected', hired:'Hired' };
  const STATUS_ORDER  = ['submitted','review','shortlisted','rejected','hired'];
  const EDU_RANK      = { none:0, highschool:1, vocational:2, associate:3, bachelor:4, master:5 };
  const EDU_LABELS    = { none:'No requirement', highschool:'High school', vocational:'Vocational / TESDA',
                          associate:'Associate degree', bachelor:'Bachelor\u2019s degree', master:'Master\u2019s degree' };
  const MAX_UPLOAD    = 2 * 1024 * 1024; // 2 MB
  const ALLOWED_MIME  = ['application/pdf', 'application/msword',
                         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                         'image/jpeg', 'image/png'];

  const KEY = 'rmph_v3_db';
  const SESSION = 'rmph_v3_session';
  const uid = () => 'x' + Math.random().toString(36).slice(2, 9);
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  /* ============================================================
     MATCHING ENGINE — mirrored 1:1 in api/_lib.php (rm_score()).
     Rule-based only: no ML, no AI, per the paper's delimitations.
     The applicant's uploaded file is NEVER read here.
     ============================================================ */
  function score(resume, posting) {
    const required = posting.skills || [];
    const have = new Set((resume.skills || []).map(norm));
    const matched = required.filter(s => have.has(norm(s)));
    const skillPart = required.length ? matched.length / required.length : 1;

    const seekerEdu = Math.max(0, ...(resume.education || []).map(e => EDU_RANK[e.level] || 0));
    const reqEdu = EDU_RANK[posting.educationLevel] || 0;
    const eduPart = reqEdu === 0 ? 1 : Math.min(1, seekerEdu / reqEdu);

    const months = (resume.experience || []).reduce((t, e) => t + (Number(e.months) || 0), 0);
    const reqMonths = Number(posting.minExperienceMonths) || 0;
    const expPart = reqMonths <= 0 ? 1 : Math.min(1, months / reqMonths);

    const raw = (skillPart * WEIGHTS.skills + eduPart * WEIGHTS.education + expPart * WEIGHTS.experience) * 100;
    const total = Math.floor(raw + 0.5);   // half-up, explicitly — must match PHP rm_score()
    return {
      score: total,
      matchedSkills: matched,
      missingSkills: required.filter(s => !have.has(norm(s))),
      totalSkills: required.length,
      eduMeets: eduPart >= 1,
      expMeets: expPart >= 1,
      seekerMonths: months,
      tier: total >= THRESHOLDS.strong ? 'strong' : total >= THRESHOLDS.related ? 'possible' : 'related',
    };
  }

  /* ============================================================
     DEMO ADAPTER — browser storage. Seeded with Royce's real
     departments so all three match tiers actually demonstrate.
     ============================================================ */
  const D = 86400000;
  function seed() {
    return {
      companies: [{
        id:'c1', name:'Royce Hotel & Casino', industry:'Hospitality & Gaming',
        location:'Manuel A. Roxas Highway, Clark Freeport Zone, Mabalacat, Pampanga',
        about:'An integrated hotel and entertainment destination in Clark Freeport Zone \u2014 500 rooms across two buildings, ten dining venues, event ballrooms, a spa, and a gaming floor. Pilot partner of this study, hiring across front office, food & beverage, housekeeping, IT, human resources, and marketing.',
        website:'https://www.roycehotelandcasino.com',
      }],
      users: [
        { id:'u1', role:'seeker', name:'Juan Dela Cruz', email:'seeker@demo.ph', password:'demo123', activeResumeId:'r1', createdAt:Date.now()-D*30 },
        // Recruiter accounts are PROVISIONED with the partner company's HR — never self-registered.
        { id:'u2', role:'recruiter', name:'Maria Santos', email:'hr@demo.ph', password:'demo123', companyId:'c1', position:'HR Officer', verified:true, createdAt:Date.now()-D*60 },
        { id:'u3', role:'seeker', name:'Ana Reyes',    email:'ana@demo.ph',   password:'demo123', activeResumeId:'r2', createdAt:Date.now()-D*20 },
        { id:'u4', role:'seeker', name:'Marco Garcia', email:'marco@demo.ph', password:'demo123', activeResumeId:'r3', createdAt:Date.now()-D*15 },
        { id:'u5', role:'seeker', name:'Liza Cruz',    email:'liza@demo.ph',  password:'demo123', activeResumeId:'r4', createdAt:Date.now()-D*10 },
      ],
      resumes: [
        { id:'r1', userId:'u1', title:'IT \u2014 fresh graduate', template:'chronological',
          personal:{ fullName:'Juan Dela Cruz', email:'seeker@demo.ph', phone:'0917 000 0000', address:'San Fernando, Pampanga',
            summary:'BS Information Technology graduate with internship experience building and maintaining public-facing web pages. Looking for an entry-level web developer role.' },
          education:[{ school:'Holy Angel University', degree:'BS Information Technology', level:'bachelor', year:'2026' }],
          experience:[{ position:'Web Development Intern', company:'LGU San Fernando', months:4, description:'Built and maintained pages for the city job portal; fixed layout issues reported by staff.' }],
          skills:['HTML/CSS','JavaScript','MySQL','Teamwork','Communication'],
          certifications:[{ name:'TESDA Web Development NC III', year:'2025' }],
          ownFile:null, updatedAt:Date.now()-D*2 },
        { id:'r2', userId:'u3', title:'Computer Science \u2014 fresh graduate', template:'chronological',
          personal:{ fullName:'Ana Reyes', email:'ana@demo.ph', phone:'0917 111 1111', address:'Mabalacat, Pampanga',
            summary:'BS Computer Science graduate with coursework projects in front-end development. Seeking a junior developer role.' },
          education:[{ school:'Angeles University Foundation', degree:'BS Computer Science', level:'bachelor', year:'2026' }],
          experience:[{ position:'Capstone Developer', company:'Angeles University Foundation', months:3, description:'Built a school event portal with a team of four.' }],
          skills:['HTML/CSS','JavaScript','Communication','Teamwork'], certifications:[],
          ownFile:null, updatedAt:Date.now()-D*4 },
        { id:'r3', userId:'u4', title:'Hospitality Management', template:'chronological',
          personal:{ fullName:'Marco Garcia', email:'marco@demo.ph', phone:'0917 222 2222', address:'Angeles City, Pampanga',
            summary:'Hospitality Management graduate with food & beverage internship experience at a Clark hotel.' },
          education:[{ school:'Holy Angel University', degree:'BS Hospitality Management', level:'bachelor', year:'2025' }],
          experience:[{ position:'F&B Intern', company:'Clark hotel', months:6, description:'Served 60+ covers per shift; handled POS billing and table turnover.' }],
          skills:['Customer Service','Communication','MS Office','English Proficiency','POS','Teamwork','Food Safety'],
          certifications:[{ name:'Food Safety Training', year:'2025' }],
          // DUAL-RESUME MODEL: the applicant's OWN file. HR views and downloads it.
          // It is NEVER parsed and NEVER scored — see the paper's delimitations.
          ownFile:{ name:'Marco_Garcia_Resume.pdf', mime:'application/pdf', size:712, uploadedAt:Date.now()-D*5,
            dataUrl:'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgNjEyIDc5Ml0vQ29udGVudHMgNCAwIFIvUmVzb3VyY2VzPDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+ZW5kb2JqCjQgMCBvYmo8PC9MZW5ndGggMjE1Pj5zdHJlYW0KQlQgL0YxIDE0IFRmIDYwIDc2MCBUZCAoTWFyY28gR2FyY2lhIC0gUmVzdW1lKSBUaiAwIC0yNCBUZCAoQlMgSG9zcGl0YWxpdHkgTWFuYWdlbWVudCwgSEFVIDIwMjUpIFRqIDAgLTIwIFRkIChGJkIgSW50ZXJuIC0gQ2xhcmsgaG90ZWwsIDYgbW9udGhzKSBUaiAwIC0yMCBUZCAoU2tpbGxzOiBDdXN0b21lciBTZXJ2aWNlLCBQT1MsIE1TIE9mZmljZSwgRW5nbGlzaCkgVGogRVQKZW5kc3RyZWFtIGVuZG9iago1IDAgb2JqPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj5lbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTIgMDAwMDAgbiAKMDAwMDAwMDEwMSAwMDAwMCBuIAowMDAwMDAwMjExIDAwMDAwIG4gCjAwMDAwMDA0NzMgMDAwMDAgbiAKdHJhaWxlcjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjUzNAolJUVPRg==' },
          updatedAt:Date.now()-D*5 },
        { id:'r4', userId:'u5', title:'HR & Marketing', template:'combination',
          personal:{ fullName:'Liza Cruz', email:'liza@demo.ph', phone:'0917 333 3333', address:'San Fernando, Pampanga',
            summary:'Psychology graduate with HR internship exposure and social media management for a student organization.' },
          education:[{ school:'University of the Assumption', degree:'BA Psychology', level:'bachelor', year:'2025' }],
          experience:[{ position:'HR Intern', company:'Manufacturing firm', months:8, description:'Assisted in screening, interview scheduling, and 201 filing.' }],
          skills:['Communication','Recruitment','MS Office','Organization','Social Media'], certifications:[],
          ownFile:null, updatedAt:Date.now()-D*7 },
      ],
      postings: [
        { id:'p1', companyId:'c1', title:'Junior Web Developer', department:'IT', employmentType:'full-time',
          description:'Maintain the hotel website, online booking pages, and internal web tools under the IT supervisor. Fresh graduates are welcome to apply.',
          skills:['HTML/CSS','JavaScript','MySQL','Teamwork'], educationLevel:'bachelor', minExperienceMonths:0, status:'open', createdAt:Date.now()-D*9 },
        { id:'p2', companyId:'c1', title:'IT Support Associate', department:'IT', employmentType:'full-time',
          description:'First-line technical support for the front office, gaming floor, and back-office systems.',
          skills:['Troubleshooting','Windows','Networking','Communication'], educationLevel:'bachelor', minExperienceMonths:0, status:'open', createdAt:Date.now()-D*7 },
        { id:'p3', companyId:'c1', title:'Front Office Associate', department:'Front Office', employmentType:'full-time',
          description:'Handle guest check-in and check-out, reservations, and inquiries at the front desk of the Premium Building.',
          skills:['Customer Service','Communication','MS Office','English Proficiency'], educationLevel:'bachelor', minExperienceMonths:0, status:'open', createdAt:Date.now()-D*6 },
        { id:'p4', companyId:'c1', title:'F&B Service Attendant', department:'Food & Beverage', employmentType:'full-time',
          description:'Serve guests across the hotel restaurants and banquet events; uphold food safety standards.',
          skills:['Customer Service','Teamwork','Food Safety','POS'], educationLevel:'highschool', minExperienceMonths:0, status:'open', createdAt:Date.now()-D*5 },
        { id:'p5', companyId:'c1', title:'HR Assistant', department:'Human Resources', employmentType:'full-time',
          description:'Assist in recruitment scheduling, 201 files, and onboarding of new hires.',
          skills:['Communication','MS Office','Recruitment','Organization'], educationLevel:'bachelor', minExperienceMonths:0, status:'open', createdAt:Date.now()-D*4 },
        { id:'p6', companyId:'c1', title:'Marketing Associate', department:'Marketing', employmentType:'full-time',
          description:'Support promotions, events, and social media for the hotel and casino.',
          skills:['Social Media','Copywriting','Canva','Communication'], educationLevel:'bachelor', minExperienceMonths:6, status:'open', createdAt:Date.now()-D*3 },
        { id:'p7', companyId:'c1', title:'Housekeeping Team Leader', department:'Housekeeping', employmentType:'full-time',
          description:'Lead a room-attendant team across the Deluxe Building; manage schedules and quality inspections.',
          skills:['Housekeeping Operations','Leadership','Scheduling','Teamwork'], educationLevel:'highschool', minExperienceMonths:12, status:'open', createdAt:Date.now()-D*2 },
      ],
      applications: [
        { id:'a1', seekerId:'u3', resumeId:'r2', postingId:'p1', status:'review',      appliedAt:Date.now()-D*3 },
        { id:'a2', seekerId:'u4', resumeId:'r3', postingId:'p1', status:'submitted',   appliedAt:Date.now()-D*2 },
        { id:'a3', seekerId:'u4', resumeId:'r3', postingId:'p3', status:'shortlisted', appliedAt:Date.now()-D*4 },
        { id:'a4', seekerId:'u5', resumeId:'r4', postingId:'p5', status:'review',      appliedAt:Date.now()-D*3 },
        { id:'a5', seekerId:'u5', resumeId:'r4', postingId:'p6', status:'submitted',   appliedAt:Date.now()-D*1 },
      ],
      recruiterRequests: [],
    };
  }

  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch (e) {}
    const db = seed(); persist(db); return db;
  }
  function persist(db) {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { throw new Error('Browser storage is full. Remove an uploaded resume file and try again.'); }
  }
  const sessionId = () => { try { return sessionStorage.getItem(SESSION); } catch (e) { return null; } };
  const setSession = id => { try { id ? sessionStorage.setItem(SESSION, id) : sessionStorage.removeItem(SESSION); } catch (e) {} };
  const ok   = data  => Promise.resolve(Object.assign({ ok:true }, data));
  const fail = error => Promise.resolve({ ok:false, error });
  const meRow = db => { const id = sessionId(); return id ? (db.users.find(u => u.id === id) || null) : null; };
  const pubUser = u => { if (!u) return null; const c = Object.assign({}, u); delete c.password; return c; };

  const demo = {
    auth: {
      login(email, password) {
        const db = load();
        const u = db.users.find(x => x.email.toLowerCase() === String(email).trim().toLowerCase() && x.password === password);
        if (!u) return fail('That email and password don\u2019t match an account.');
        if (u.role === 'recruiter' && !u.verified)
          return fail('This recruiter account isn\u2019t active yet. Accounts are activated by the research team together with the partner company\u2019s HR.');
        setSession(u.id);
        return ok({ user: pubUser(u) });
      },
      registerSeeker({ name, email, password }) {
        const db = load();
        if (db.users.some(u => u.email.toLowerCase() === String(email).trim().toLowerCase()))
          return fail('An account already uses this email. Log in instead.');
        const user = { id:uid(), role:'seeker', name:String(name).trim(), email:String(email).trim(), password, activeResumeId:null, createdAt:Date.now() };
        db.users.push(user); persist(db); setSession(user.id);
        return ok({ user: pubUser(user) });
      },
      requestRecruiterAccess({ name, email, position, companyId, note }) {
        const db = load();
        const e = String(email).trim().toLowerCase();
        if (db.users.some(u => u.email.toLowerCase() === e)) return fail('An account already uses this email.');
        if (db.recruiterRequests.some(r => r.email.toLowerCase() === e && r.status === 'pending'))
          return fail('A request from this email is already waiting for review.');
        db.recruiterRequests.push({ id:uid(), name, email, position, companyId, note:note || '', status:'pending', requestedAt:Date.now() });
        persist(db);
        return ok({});
      },
      logout() { setSession(null); return ok({}); },
      me() { return ok({ user: pubUser(meRow(load())) }); },
      changePassword(current, next) {
        const db = load(); const u = meRow(db);
        if (!u) return fail('You are not signed in.');
        if (u.password !== current) return fail('Your current password is incorrect.');
        u.password = next; persist(db);
        return ok({});
      },
      deleteAccount(password) {
        const db = load(); const u = meRow(db);
        if (!u) return fail('You are not signed in.');
        if (u.password !== password) return fail('Password is incorrect.');
        db.resumes = db.resumes.filter(r => r.userId !== u.id);
        db.applications = db.applications.filter(a => a.seekerId !== u.id);
        db.users = db.users.filter(x => x.id !== u.id);
        persist(db); setSession(null);
        return ok({});
      },
      // RA 10173, right of access: the person can take their data with them.
      exportMyData() {
        const db = load(); const u = meRow(db);
        if (!u) return fail('You are not signed in.');
        return ok({ data: {
          exportedAt: new Date().toISOString(),
          account: pubUser(u),
          resumes: db.resumes.filter(r => r.userId === u.id).map(r =>
            Object.assign({}, r, { ownFile: r.ownFile ? { name:r.ownFile.name, mime:r.ownFile.mime, size:r.ownFile.size, note:'Download the file itself from My resumes.' } : null })),
          applications: db.applications.filter(a => a.seekerId === u.id),
        }});
      },
    },

    companies: {
      list() { return ok({ companies: load().companies }); },
      get(id) { const c = load().companies.find(x => x.id === id); return c ? ok({ company:c }) : fail('Company not found.'); },
      update(id, patch) {
        const db = load(); const me = meRow(db);
        if (!me || me.role !== 'recruiter' || me.companyId !== id) return fail('You can only edit your own company profile.');
        Object.assign(db.companies.find(c => c.id === id), patch); persist(db);
        return ok({});
      },
    },

    resumes: {
      mine() {
        const db = load(); const me = meRow(db);
        if (!me) return fail('You are not signed in.');
        return ok({ resumes: db.resumes.filter(r => r.userId === me.id).sort((a,b) => b.updatedAt - a.updatedAt) });
      },
      get(id) {
        const db = load(); const me = meRow(db);
        const r = db.resumes.find(x => x.id === id);
        if (!r) return fail('Resume not found.');
        if (me && me.role === 'recruiter') {
          // a recruiter may read a resume only if it was actually submitted to their company
          const reachable = db.applications.some(a => a.resumeId === id &&
            (db.postings.find(p => p.id === a.postingId) || {}).companyId === me.companyId);
          return reachable ? ok({ resume:r }) : fail('You can only view resumes submitted to your company.');
        }
        if (!me || r.userId !== me.id) return fail('You can only view your own resumes.');
        return ok({ resume:r });
      },
      save(resume) {
        const db = load(); const me = meRow(db);
        if (!me) return fail('You are not signed in.');
        const i = db.resumes.findIndex(r => r.id === resume.id);
        try {
          if (i >= 0) {
            if (db.resumes[i].userId !== me.id) return fail('You can only edit your own resumes.');
            db.resumes[i] = Object.assign({}, db.resumes[i], resume, { userId: me.id, updatedAt: Date.now() });
          } else {
            resume.id = resume.id || uid();
            resume.userId = me.id; resume.updatedAt = Date.now();
            if (resume.ownFile === undefined) resume.ownFile = null;
            db.resumes.push(resume);
            const u = db.users.find(x => x.id === me.id);
            if (!u.activeResumeId) u.activeResumeId = resume.id;
          }
          persist(db);
        } catch (e) { return fail(e.message); }
        return ok({ resume: db.resumes.find(r => r.id === resume.id) });
      },
      remove(id) {
        const db = load(); const me = meRow(db);
        if (!me) return fail('You are not signed in.');
        const r = db.resumes.find(x => x.id === id);
        if (!r || r.userId !== me.id) return fail('Resume not found.');
        if (db.applications.some(a => a.resumeId === id))
          return fail('This resume is attached to an application, so it can\u2019t be deleted \u2014 the recruiter still needs to see exactly what you sent. Duplicate it and edit the copy instead.');
        db.resumes = db.resumes.filter(x => x.id !== id);
        const u = db.users.find(x => x.id === me.id);
        if (u.activeResumeId === id) u.activeResumeId = (db.resumes.find(x => x.userId === me.id) || {}).id || null;
        persist(db);
        return ok({});
      },
      duplicate(id) {
        const db = load(); const me = meRow(db);
        const src = db.resumes.find(x => x.id === id);
        if (!me || !src || src.userId !== me.id) return fail('Resume not found.');
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = uid(); copy.title = src.title + ' (copy)'; copy.updatedAt = Date.now(); copy.ownFile = null;
        db.resumes.push(copy);
        try { persist(db); } catch (e) { return fail(e.message); }
        return ok({ resume: copy });
      },
      setActive(resumeId) {
        const db = load(); const me = meRow(db);
        if (!me) return fail('You are not signed in.');
        const r = db.resumes.find(x => x.id === resumeId);
        if (!r || r.userId !== me.id) return fail('Resume not found.');
        db.users.find(u => u.id === me.id).activeResumeId = resumeId;
        persist(db);
        return ok({});
      },
      uploadFile(resumeId, file) {
        const db = load(); const me = meRow(db);
        const r = db.resumes.find(x => x.id === resumeId);
        if (!me || !r || r.userId !== me.id) return fail('Resume not found.');
        if (file.size > MAX_UPLOAD) return fail('That file is larger than 2 MB. Save it at a smaller size and try again.');
        if (!ALLOWED_MIME.includes(file.type)) return fail('Upload a PDF, Word document, or image (JPG or PNG).');
        return new Promise(resolve => {
          const fr = new FileReader();
          fr.onload = () => {
            try {
              r.ownFile = { name:file.name, mime:file.type, size:file.size, uploadedAt:Date.now(), dataUrl:fr.result };
              r.updatedAt = Date.now();
              persist(db);
              resolve({ ok:true, ownFile:r.ownFile });
            } catch (e) { resolve({ ok:false, error:e.message }); }
          };
          fr.onerror = () => resolve({ ok:false, error:'That file couldn\u2019t be read. Try another one.' });
          fr.readAsDataURL(file);
        });
      },
      removeFile(resumeId) {
        const db = load(); const me = meRow(db);
        const r = db.resumes.find(x => x.id === resumeId);
        if (!me || !r || r.userId !== me.id) return fail('Resume not found.');
        r.ownFile = null; r.updatedAt = Date.now(); persist(db);
        return ok({});
      },
      fileUrl(resumeId) {
        const r = load().resumes.find(x => x.id === resumeId);
        return r && r.ownFile ? r.ownFile.dataUrl : null;
      },
    },

    postings: {
      open() {
        const db = load();
        return ok({ postings: db.postings.filter(p => p.status === 'open')
          .map(p => Object.assign({}, p, { company: db.companies.find(c => c.id === p.companyId) })) });
      },
      mine() {   // recruiter: every posting of my company, open or closed
        const db = load(); const me = meRow(db);
        if (!me || me.role !== 'recruiter') return fail('Recruiter access only.');
        return ok({ postings: db.postings.filter(p => p.companyId === me.companyId)
          .map(p => Object.assign({}, p, {
            company: db.companies.find(c => c.id === p.companyId),
            applicantCount: db.applications.filter(a => a.postingId === p.id).length,
            newCount: db.applications.filter(a => a.postingId === p.id && a.status === 'submitted').length,
          }))
          .sort((a,b) => b.createdAt - a.createdAt) });
      },
      get(id) {
        const db = load();
        const p = db.postings.find(x => x.id === id);
        if (!p) return fail('That opening no longer exists.');
        return ok({ posting: Object.assign({}, p, { company: db.companies.find(c => c.id === p.companyId) }) });
      },
      save(posting) {
        const db = load(); const me = meRow(db);
        if (!me || me.role !== 'recruiter') return fail('Recruiter access only.');
        const i = db.postings.findIndex(p => p.id === posting.id);
        if (i >= 0) {
          if (db.postings[i].companyId !== me.companyId) return fail('You can only edit your own company\u2019s openings.');
          db.postings[i] = Object.assign({}, db.postings[i], posting);
        } else {
          posting.id = uid(); posting.companyId = me.companyId;
          posting.status = posting.status || 'open'; posting.createdAt = Date.now();
          db.postings.push(posting);
        }
        persist(db);
        return ok({ posting: db.postings.find(p => p.id === posting.id) });
      },
      toggle(id) {
        const db = load(); const me = meRow(db);
        const p = db.postings.find(x => x.id === id);
        if (!me || me.role !== 'recruiter' || !p || p.companyId !== me.companyId) return fail('Opening not found.');
        p.status = p.status === 'open' ? 'closed' : 'open'; persist(db);
        return ok({ posting: p });
      },
    },

    applications: {
      apply(resumeId, postingId) {
        const db = load(); const me = meRow(db);
        if (!me || me.role !== 'seeker') return fail('Sign in as a job seeker to apply.');
        const r = db.resumes.find(x => x.id === resumeId);
        if (!r || r.userId !== me.id) return fail('Choose one of your own resumes.');
        const p = db.postings.find(x => x.id === postingId);
        if (!p || p.status !== 'open') return fail('This opening is closed.');
        if (db.applications.some(a => a.seekerId === me.id && a.postingId === postingId))
          return fail('You already applied to this position.');
        const app = { id:uid(), seekerId:me.id, resumeId, postingId, status:'submitted', appliedAt:Date.now() };
        db.applications.push(app); persist(db);
        return ok({ application: app });
      },
      mine() {
        const db = load(); const me = meRow(db);
        if (!me) return fail('You are not signed in.');
        return ok({ applications: db.applications.filter(a => a.seekerId === me.id).map(a => {
          const p = db.postings.find(x => x.id === a.postingId);
          return Object.assign({}, a, {
            posting: p,
            company: db.companies.find(c => c.id === (p || {}).companyId),
            resumeTitle: (db.resumes.find(r => r.id === a.resumeId) || {}).title || null,
          });
        }).sort((a,b) => b.appliedAt - a.appliedAt) });
      },
      // The ranked shortlist. Every applicant is on it — nobody is filtered off.
      ranked(postingId) {
        const db = load(); const me = meRow(db);
        if (!me || me.role !== 'recruiter') return fail('Recruiter access only.');
        const p = db.postings.find(x => x.id === postingId);
        if (!p || p.companyId !== me.companyId) return fail('Opening not found.');
        const rows = db.applications.filter(a => a.postingId === postingId).map(a => {
          const resume = db.resumes.find(r => r.id === a.resumeId);
          const seeker = db.users.find(u => u.id === a.seekerId);
          return Object.assign({ application:a, resume, seeker:pubUser(seeker) }, score(resume, p));
        }).sort((x,y) => y.score - x.score || x.application.appliedAt - y.application.appliedAt);
        return ok({ posting:p, rows });
      },
      setStatus(applicationId, status) {
        const db = load(); const me = meRow(db);
        if (!me || me.role !== 'recruiter') return fail('Recruiter access only.');
        if (STATUS_ORDER.indexOf(status) === -1) return fail('Unknown status.');
        const a = db.applications.find(x => x.id === applicationId);
        if (!a) return fail('Application not found.');
        const p = db.postings.find(x => x.id === a.postingId);
        if (!p || p.companyId !== me.companyId) return fail('Application not found.');
        a.status = status; a.updatedAt = Date.now(); a.decidedBy = me.id;   // a human made this call
        persist(db);
        return ok({ application: a });
      },
    },

    match: {
      score(resumeId, postingId) {
        const db = load();
        const r = db.resumes.find(x => x.id === resumeId), p = db.postings.find(x => x.id === postingId);
        if (!r || !p) return fail('Not found.');
        return ok(score(r, p));
      },
      // Three tiers. The third exists so a low score is a redirection, not a rejection.
      recommendations() {
        const db = load(); const me = meRow(db);
        if (!me) return fail('You are not signed in.');
        const resume = db.resumes.find(r => r.id === me.activeResumeId) || db.resumes.find(r => r.userId === me.id);
        if (!resume) return ok({ resume:null, strong:[], possible:[], related:[] });
        const applied = db.applications.filter(a => a.seekerId === me.id).map(a => a.postingId);
        const scored = db.postings.filter(p => p.status === 'open').map(p => Object.assign({
          posting: p,
          company: db.companies.find(c => c.id === p.companyId),
          applied: applied.indexOf(p.id) !== -1,
        }, score(resume, p))).sort((a,b) => b.score - a.score);
        return ok({
          resume,
          strong:   scored.filter(s => s.tier === 'strong'),
          possible: scored.filter(s => s.tier === 'possible'),
          // a related role must share at least one real skill, or it's noise rather than a suggestion
          related:  scored.filter(s => s.tier === 'related' && s.matchedSkills.length > 0),
        });
      },
    },

    stats: {
      hr() {
        const db = load(); const me = meRow(db);
        if (!me || me.role !== 'recruiter') return fail('Recruiter access only.');
        const mine = db.postings.filter(p => p.companyId === me.companyId);
        const ids = mine.map(p => p.id);
        const apps = db.applications.filter(a => ids.indexOf(a.postingId) !== -1);
        const byStatus = {}; STATUS_ORDER.forEach(s => byStatus[s] = apps.filter(a => a.status === s).length);
        return ok({ stats: {
          openPostings: mine.filter(p => p.status === 'open').length,
          totalPostings: mine.length,
          totalApplicants: apps.length,
          needsReview: apps.filter(a => a.status === 'submitted').length,
          byStatus,
        }});
      },
    },

    resetDemo() {
      try { localStorage.removeItem(KEY); sessionStorage.removeItem(SESSION); } catch (e) {}
      return ok({});
    },
  };

  /* ============================================================
     PHP ADAPTER — identical surface, backed by MySQL via api/*.php
     ============================================================ */
  async function call(endpoint, action, payload) {
    const url = CONFIG.apiBase + '/' + endpoint + '.php?action=' + action;
    try {
      const res = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      const data = await res.json();
      if (!res.ok && !data.error) return { ok:false, error:'Server error (' + res.status + ').' };
      return data;
    } catch (e) {
      return { ok:false, error:'Can\u2019t reach the server. Check that Apache and MySQL are running in XAMPP.' };
    }
  }

  const php = {
    auth: {
      login: (email, password)  => call('auth','login', { email, password }),
      registerSeeker: d         => call('auth','register', d),
      requestRecruiterAccess: d => call('auth','request-access', d),
      logout: ()                => call('auth','logout'),
      me: ()                    => call('auth','me'),
      changePassword: (c, n)    => call('auth','change-password', { current:c, next:n }),
      deleteAccount: p          => call('auth','delete-account', { password:p }),
      exportMyData: ()          => call('auth','export'),
    },
    companies: {
      list: ()           => call('companies','list'),
      get: id            => call('companies','get', { id }),
      update: (id, patch)=> call('companies','update', Object.assign({ id }, patch)),
    },
    resumes: {
      mine: ()      => call('resumes','list'),
      get: id       => call('resumes','get', { id }),
      save: r       => call('resumes','save', { resume:r }),
      remove: id    => call('resumes','delete', { id }),
      duplicate: id => call('resumes','duplicate', { id }),
      setActive: id => call('resumes','set-active', { id }),
      async uploadFile(resumeId, file) {
        if (file.size > MAX_UPLOAD) return { ok:false, error:'That file is larger than 2 MB. Save it at a smaller size and try again.' };
        if (ALLOWED_MIME.indexOf(file.type) === -1) return { ok:false, error:'Upload a PDF, Word document, or image (JPG or PNG).' };
        const fd = new FormData();
        fd.append('resume_id', resumeId); fd.append('file', file);
        try {
          const res = await fetch(CONFIG.apiBase + '/resumes.php?action=upload', { method:'POST', credentials:'include', body: fd });
          return await res.json();
        } catch (e) { return { ok:false, error:'Upload failed. Check that the server is running.' }; }
      },
      removeFile: id => call('resumes','remove-file', { id }),
      // served through an auth-checked endpoint — applicant files are never a guessable public URL
      fileUrl: id => CONFIG.apiBase + '/file.php?resume_id=' + encodeURIComponent(id),
    },
    postings: {
      open: ()   => call('postings','list'),
      mine: ()   => call('postings','mine'),
      get: id    => call('postings','get', { id }),
      save: p    => call('postings','save', { posting:p }),
      toggle: id => call('postings','toggle', { id }),
    },
    applications: {
      apply: (resumeId, postingId) => call('applications','apply', { resumeId, postingId }),
      mine: ()                     => call('applications','mine'),
      ranked: postingId            => call('applications','ranked', { postingId }),
      setStatus: (id, status)      => call('applications','set-status', { id, status }),
    },
    match: {
      score: (resumeId, postingId) => call('match','score', { resumeId, postingId }),
      recommendations: ()          => call('match','recommendations'),
    },
    stats: { hr: () => call('stats','hr') },
    resetDemo: () => Promise.resolve({ ok:false, error:'Not available in server mode.' }),
  };

  /* ============================================================
     Public surface
     ============================================================ */
  const impl = CONFIG.mode === 'php' ? php : demo;

  Object.assign(impl, {
    CONFIG, WEIGHTS, THRESHOLDS, STATUS_LABELS, STATUS_ORDER, EDU_RANK, EDU_LABELS, MAX_UPLOAD, ALLOWED_MIME,
    scoreLocal: score,   // used by the builder's live "how would this score" preview

    tierOf: n => n >= THRESHOLDS.strong ? 'strong' : n >= THRESHOLDS.related ? 'possible' : 'related',
    tierColor(n) {
      const t = impl.tierOf(n);
      return t === 'strong' ? 'var(--emerald)' : t === 'possible' ? 'var(--gold)' : 'var(--slate)';
    },
    tierLabel(n) {
      const t = impl.tierOf(n);
      return t === 'strong' ? 'Strong match' : t === 'possible' ? 'Possible match' : 'Related role';
    },
    statusBadge: s => ({ submitted:'slate', review:'gold', shortlisted:'green', hired:'solid', rejected:'wine' }[s] || 'slate'),

    /* Route guard. On failure it redirects and returns a promise that
       never settles, so page code after `await guard()` can safely
       assume a valid, correctly-roled user.                          */
    async guard(role) {
      const res = await impl.auth.me();
      const u = res && res.ok ? res.user : null;
      if (!u) {
        location.replace('auth.html?next=' + encodeURIComponent(location.pathname.split('/').pop()));
        return new Promise(() => {});
      }
      if (role && u.role !== role) {
        location.replace(u.role === 'seeker' ? 'seeker-dashboard.html' : 'hr-dashboard.html');
        return new Promise(() => {});
      }
      return u;
    },
  });

  global.RMPH = impl;

  /* ============================================================
     Shared chrome: mobile menu, identity, log out, year stamp
     ============================================================ */
  document.addEventListener('DOMContentLoaded', async () => {
    const burger = document.querySelector('.menu-btn');
    const links = document.querySelector('.nav-links');
    if (burger && links) burger.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    document.querySelectorAll('[data-year]').forEach(el => { el.textContent = new Date().getFullYear(); });

    const bindLogout = root => root.querySelectorAll('[data-logout]').forEach(b =>
      b.addEventListener('click', async () => { await impl.auth.logout(); location.href = 'index.html'; }));
    bindLogout(document);

    let u = null;
    try { const r = await impl.auth.me(); u = r && r.ok ? r.user : null; } catch (e) {}

    const home = u ? (u.role === 'seeker' ? 'seeker-dashboard.html' : 'hr-dashboard.html') : null;

    if (u) {
      document.querySelectorAll('[data-whoami]').forEach(el => { el.textContent = u.name; });

      const cta = document.querySelector('[data-auth-cta]');
      if (cta) {
        cta.innerHTML =
          '<span class="whoami">' + u.name + '</span>' +
          '<a class="btn ghost sm" href="' + home + '">My dashboard</a>' +
          '<button class="btn primary sm" type="button" data-logout>Log out</button>';
        bindLogout(cta);
      }
    }

    /* The header CTA is hidden on narrow screens, so the same actions are
       mirrored into the menu. Otherwise a phone user can't log out.       */
    if (links) {
      const mob = document.createElement('div');
      mob.className = 'nav-mob';
      mob.innerHTML = u
        ? '<span class="who">' + u.name + '</span>' +
          '<a class="btn ghost sm" href="' + home + '">My dashboard</a>' +
          '<button class="btn primary sm" type="button" data-logout>Log out</button>'
        : '<a class="btn ghost sm" href="auth.html">Log in</a>' +
          '<a class="btn primary sm" href="auth.html#register">Create free account</a>';
      links.appendChild(mob);
      bindLogout(mob);
    }
  });
})(window);
