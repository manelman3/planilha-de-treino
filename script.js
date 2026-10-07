/* ==========================================================================
   FORJA — Rastreador de treino (v2: grupos > treinos > exercícios)
   Tudo persistido em LocalStorage. Sem backend, sem libs externas.
   ========================================================================== */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  const STORAGE_KEY = 'forja:data:v2';
  const RING_RADIUS = 52;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  const WEEKDAY_LABELS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const MONTH_LABELS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  /**
   * data.groups: [{ id, name, createdAt, subgroups: [{ id, name, createdAt,
   *   exercises: [{ id, name, sets, time, notes, photo, videoUrl, createdAt }]
   * }]}]
   * data.progress: { "YYYY-MM-DD": { [exerciseId]: [bool, bool, ...] } }
   */
  let data = loadData();

  // view: { type: 'home' } | { type: 'group', groupId } | { type: 'subgroup', groupId, subgroupId }
  let view = { type: 'home' };

  let searchQuery = '';
  let sortMode = 'time';
  let confirmCallback = null;
  let pendingPhotoDataUrl = null;

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { groups: [], progress: {} };
      const parsed = JSON.parse(raw);
      return {
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        progress: parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {},
      };
    } catch (err) {
      console.error('Falha ao carregar dados salvos:', err);
      return { groups: [], progress: {} };
    }
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      console.error('Falha ao salvar dados:', err);
      toast('Armazenamento cheio. Remova alguma foto ou exporte um backup e limpe exercícios antigos.', 'danger');
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Date helpers
  // ---------------------------------------------------------------------

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatFullDate(date) {
    const weekday = WEEKDAY_LABELS[date.getDay()];
    const month = MONTH_LABELS[date.getMonth()];
    return `${weekday}, ${date.getDate()} de ${month}`;
  }

  // ---------------------------------------------------------------------
  // Data lookup helpers
  // ---------------------------------------------------------------------

  function findGroup(groupId) {
    return data.groups.find((g) => g.id === groupId) || null;
  }

  function findSubgroup(groupId, subgroupId) {
    const group = findGroup(groupId);
    if (!group) return { group: null, subgroup: null };
    const subgroup = group.subgroups.find((s) => s.id === subgroupId) || null;
    return { group, subgroup };
  }

  function findExerciseAnywhere(exerciseId) {
    for (const group of data.groups) {
      for (const subgroup of group.subgroups) {
        const exercise = subgroup.exercises.find((e) => e.id === exerciseId);
        if (exercise) return { group, subgroup, exercise };
      }
    }
    return { group: null, subgroup: null, exercise: null };
  }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------------------------------------------------------------------
  // Progress / completion logic
  // ---------------------------------------------------------------------

  function getProgressArray(exercise, dateKey) {
    const dayMap = data.progress[dateKey];
    const arr = dayMap ? dayMap[exercise.id] : null;
    if (!arr) return new Array(exercise.sets).fill(false);
    if (arr.length === exercise.sets) return arr;
    const resized = new Array(exercise.sets).fill(false);
    for (let i = 0; i < Math.min(arr.length, exercise.sets); i++) resized[i] = arr[i];
    return resized;
  }

  function setProgressArray(exercise, dateKey, arr) {
    if (!data.progress[dateKey]) data.progress[dateKey] = {};
    data.progress[dateKey][exercise.id] = arr;
  }

  function toggleSet(exerciseId, dateKey, setIndex) {
    const { exercise } = findExerciseAnywhere(exerciseId);
    if (!exercise) return;
    const arr = getProgressArray(exercise, dateKey).slice();
    arr[setIndex] = !arr[setIndex];
    setProgressArray(exercise, dateKey, arr);
    saveData();
    renderCurrentView();
  }

  function computeExerciseState(exercise, dateKey) {
    const arr = getProgressArray(exercise, dateKey);
    const done = arr.filter(Boolean).length;
    const total = exercise.sets;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return { arr, done, total, pct, complete: done === total && total > 0 };
  }

  function computeSubgroupState(subgroup, dateKey) {
    let totalSets = 0;
    let doneSets = 0;
    let completedExercises = 0;
    subgroup.exercises.forEach((ex) => {
      const st = computeExerciseState(ex, dateKey);
      totalSets += st.total;
      doneSets += st.done;
      if (st.complete) completedExercises++;
    });
    const pct = totalSets > 0 ? Math.round((doneSets / totalSets) * 100) : 0;
    return {
      totalSets,
      doneSets,
      pct,
      totalExercises: subgroup.exercises.length,
      completedExercises,
      allComplete: subgroup.exercises.length > 0 && completedExercises === subgroup.exercises.length,
    };
  }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  const currentDateEl = $('currentDate');
  const breadcrumbEl = $('breadcrumb');
  const mainView = $('mainView');
  const addBtn = $('addBtn');
  const addBtnLabel = $('addBtnLabel');

  const groupModal = $('groupModal');
  const groupForm = $('groupForm');
  const groupModalTitle = $('groupModalTitle');
  const groupNameInput = $('groupName');
  const deleteGroupBtn = $('deleteGroupBtn');

  const subgroupModal = $('subgroupModal');
  const subgroupForm = $('subgroupForm');
  const subgroupModalTitle = $('subgroupModalTitle');
  const subgroupNameInput = $('subgroupName');
  const deleteSubgroupBtn = $('deleteSubgroupBtn');

  const exerciseModal = $('exerciseModal');
  const exerciseForm = $('exerciseForm');
  const exerciseModalTitle = $('exerciseModalTitle');
  const exerciseNameInput = $('exerciseName');
  const exerciseSetsInput = $('exerciseSets');
  const exerciseTimeInput = $('exerciseTime');
  const exerciseNotesInput = $('exerciseNotes');
  const exerciseVideoUrlInput = $('exerciseVideoUrl');
  const deleteExerciseBtn = $('deleteExerciseBtn');
  const photoPreviewWrap = $('photoPreviewWrap');
  const photoPreview = $('photoPreview');
  const photoUploadBtn = $('photoUploadBtn');
  const photoRemoveBtn = $('photoRemoveBtn');
  const exercisePhotoInput = $('exercisePhotoInput');

  const confirmModal = $('confirmModal');
  const confirmTitle = $('confirmTitle');
  const confirmMessage = $('confirmMessage');

  const lightbox = $('lightbox');
  const lightboxImg = $('lightboxImg');

  const toastContainer = $('toastContainer');

  // Modal editing context
  let editingGroupId = null;
  let editingSubgroupGroupId = null;
  let editingSubgroupId = null;
  let editingExerciseCtx = null; // { groupId, subgroupId, exerciseId }

  // ---------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------

  function toast(message, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 200ms ease';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  // ---------------------------------------------------------------------
  // Ring builder (signature element)
  // ---------------------------------------------------------------------

  function buildRing(pct, size, strokeWidth, big) {
    const offset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
    const wrap = document.createElement('div');
    wrap.className = 'ring-wrap ' + (big ? 'ring-wrap--lg' : 'ring-wrap--sm') + (pct >= 100 ? ' is-complete' : '');
    wrap.style.width = size + 'px';
    wrap.style.height = size + 'px';
    wrap.innerHTML =
      '<svg viewBox="0 0 120 120" width="' + size + '" height="' + size + '">' +
      '<circle class="ring-track" cx="60" cy="60" r="' + RING_RADIUS + '" stroke-width="' + strokeWidth + '"/>' +
      '<circle class="ring-fill" cx="60" cy="60" r="' + RING_RADIUS + '" stroke-width="' + strokeWidth +
      '" stroke-dasharray="' + RING_CIRCUMFERENCE + '" stroke-dashoffset="' + offset + '"/>' +
      '</svg>' +
      '<div class="ring-center"><span class="ring-center__pct">' + pct + '%</span></div>';
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Breadcrumb
  // ---------------------------------------------------------------------

  function renderBreadcrumb() {
    breadcrumbEl.innerHTML = '';

    const homeItem = document.createElement('button');
    homeItem.type = 'button';
    homeItem.className = 'breadcrumb__item' + (view.type === 'home' ? ' current' : '');
    homeItem.textContent = 'Início';
    homeItem.addEventListener('click', () => navigate({ type: 'home' }));
    breadcrumbEl.appendChild(homeItem);

    if (view.type === 'group' || view.type === 'subgroup') {
      const group = findGroup(view.groupId);
      if (!group) return;
      addSep();
      const groupItem = document.createElement('button');
      groupItem.type = 'button';
      groupItem.className = 'breadcrumb__item' + (view.type === 'group' ? ' current' : '');
      groupItem.textContent = group.name;
      groupItem.addEventListener('click', () => navigate({ type: 'group', groupId: group.id }));
      breadcrumbEl.appendChild(groupItem);
    }

    if (view.type === 'subgroup') {
      const { subgroup } = findSubgroup(view.groupId, view.subgroupId);
      if (!subgroup) return;
      addSep();
      const subItem = document.createElement('button');
      subItem.type = 'button';
      subItem.className = 'breadcrumb__item current';
      subItem.textContent = subgroup.name;
      breadcrumbEl.appendChild(subItem);
    }

    function addSep() {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb__sep';
      sep.textContent = '/';
      breadcrumbEl.appendChild(sep);
    }
  }

  // ---------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------

  function navigate(next) {
    view = next;
    renderCurrentView();
  }

  function renderCurrentView() {
    renderBreadcrumb();
    if (view.type === 'home') {
      addBtnLabel.textContent = 'Novo grupo';
      renderHomeView();
    } else if (view.type === 'group') {
      const group = findGroup(view.groupId);
      if (!group) { navigate({ type: 'home' }); return; }
      addBtnLabel.textContent = 'Novo treino';
      renderGroupView(group);
    } else if (view.type === 'subgroup') {
      const { group, subgroup } = findSubgroup(view.groupId, view.subgroupId);
      if (!group || !subgroup) { navigate({ type: 'home' }); return; }
      addBtnLabel.textContent = 'Novo exercício';
      renderSubgroupView(group, subgroup);
    }
  }

  // ---------------------------------------------------------------------
  // HOME view: list of groups
  // ---------------------------------------------------------------------

  function renderHomeView() {
    mainView.innerHTML = '';

    if (data.groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" width="52" height="52"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>' +
        '<h3>Nenhum grupo de treino ainda</h3>' +
        '<p>Crie um grupo (ex: "Treino 5x por semana") para organizar seus treinos.</p>';
      mainView.appendChild(empty);
      const addCard = buildAddFolderCard('Novo grupo', () => openGroupModal('create'));
      mainView.appendChild(addCard);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'folder-grid';

    data.groups.forEach((group, idx) => {
      const totalSubgroups = group.subgroups.length;
      const totalExercises = group.subgroups.reduce((sum, s) => sum + s.exercises.length, 0);

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'folder-card folder-' + (idx % 8);
      card.addEventListener('click', () => navigate({ type: 'group', groupId: group.id }));

      const top = document.createElement('div');
      top.className = 'folder-card__top';
      const iconBox = document.createElement('div');
      iconBox.className = 'folder-card__icon';
      iconBox.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
      top.appendChild(iconBox);

      const editBtn = document.createElement('span');
      editBtn.className = 'btn btn--icon btn--icon-sm folder-card__edit';
      editBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); openGroupModal('edit', group); });
      top.appendChild(editBtn);
      card.appendChild(top);

      const name = document.createElement('div');
      name.className = 'folder-card__name';
      name.textContent = group.name;
      card.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'folder-card__meta';
      meta.textContent = `${totalSubgroups} treino${totalSubgroups !== 1 ? 's' : ''} · ${totalExercises} exercício${totalExercises !== 1 ? 's' : ''}`;
      card.appendChild(meta);

      grid.appendChild(card);
    });

    grid.appendChild(buildAddFolderCard('Novo grupo', () => openGroupModal('create')));
    mainView.appendChild(grid);
  }

  function buildAddFolderCard(label, onClick) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'folder-card__add';
    card.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
      '<span>' + label + '</span>';
    card.addEventListener('click', onClick);
    return card;
  }

  // ---------------------------------------------------------------------
  // GROUP view: list of subgroups (treinos)
  // ---------------------------------------------------------------------

  function renderGroupView(group) {
    mainView.innerHTML = '';
    const dateKey = todayKey();

    const headerRow = document.createElement('div');
    headerRow.className = 'treino-header';
    headerRow.innerHTML =
      '<div class="treino-header__info">' +
      '<div class="treino-header__name">' + escapeHtml(group.name) + '</div>' +
      '<div class="treino-header__sub">' + group.subgroups.length + ' treino' + (group.subgroups.length !== 1 ? 's' : '') + ' nesse grupo</div>' +
      '</div>';
    const actions = document.createElement('div');
    actions.className = 'treino-header__actions';
    const editGroupBtn = document.createElement('button');
    editGroupBtn.type = 'button';
    editGroupBtn.className = 'btn btn--icon';
    editGroupBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    editGroupBtn.addEventListener('click', () => openGroupModal('edit', group));
    actions.appendChild(editGroupBtn);
    headerRow.appendChild(actions);
    mainView.appendChild(headerRow);

    if (group.subgroups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" width="52" height="52"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>' +
        '<h3>Nenhum treino nesse grupo</h3>' +
        '<p>Crie um treino, como "Treino A", e adicione os exercícios dentro dele.</p>';
      mainView.appendChild(empty);
      mainView.appendChild(buildAddFolderCard('Novo treino', () => openSubgroupModal('create', group.id)));
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'folder-grid';

    group.subgroups.forEach((subgroup, idx) => {
      const state = computeSubgroupState(subgroup, dateKey);

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'folder-card folder-' + (idx % 8);
      card.addEventListener('click', () => navigate({ type: 'subgroup', groupId: group.id, subgroupId: subgroup.id }));

      const top = document.createElement('div');
      top.className = 'folder-card__top';
      top.appendChild(buildRing(state.pct, 46, 6, false));

      const editBtn = document.createElement('span');
      editBtn.className = 'btn btn--icon btn--icon-sm folder-card__edit';
      editBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); openSubgroupModal('edit', group.id, subgroup); });
      top.appendChild(editBtn);
      card.appendChild(top);

      const name = document.createElement('div');
      name.className = 'folder-card__name';
      name.textContent = subgroup.name;
      card.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'folder-card__meta';
      meta.textContent = `${state.totalExercises} exercício${state.totalExercises !== 1 ? 's' : ''} hoje`;
      card.appendChild(meta);

      grid.appendChild(card);
    });

    grid.appendChild(buildAddFolderCard('Novo treino', () => openSubgroupModal('create', group.id)));
    mainView.appendChild(grid);
  }

  // ---------------------------------------------------------------------
  // SUBGROUP (treino) view: ring header + exercise list
  // ---------------------------------------------------------------------

  function getFilteredSortedExercises(subgroup) {
    let list = subgroup.exercises.slice();
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((e) => e.name.toLowerCase().includes(q));
    }
    const dateKey = todayKey();
    list.sort((a, b) => {
      if (sortMode === 'time') {
        if (!a.time && !b.time) return a.name.localeCompare(b.name);
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time.localeCompare(b.time);
      }
      if (sortMode === 'progress') {
        return computeExerciseState(b, dateKey).pct - computeExerciseState(a, dateKey).pct;
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  function renderSubgroupView(group, subgroup) {
    mainView.innerHTML = '';
    const dateKey = todayKey();
    const state = computeSubgroupState(subgroup, dateKey);

    // Header with big ring
    const header = document.createElement('div');
    header.className = 'treino-header';
    header.appendChild(buildRing(state.pct, 96, 9, true));

    const info = document.createElement('div');
    info.className = 'treino-header__info';
    const nameEl = document.createElement('div');
    nameEl.className = 'treino-header__name';
    nameEl.textContent = subgroup.name;
    info.appendChild(nameEl);
    const sub = document.createElement('div');
    sub.className = 'treino-header__sub';
    sub.innerHTML = '<strong>' + state.completedExercises + ' de ' + state.totalExercises + '</strong> exercícios concluídos hoje · <strong>' + state.doneSets + ' de ' + state.totalSets + '</strong> séries';
    info.appendChild(sub);
    header.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'treino-header__actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn--icon';
    editBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    editBtn.addEventListener('click', () => openSubgroupModal('edit', group.id, subgroup));
    actions.appendChild(editBtn);
    header.appendChild(actions);

    mainView.appendChild(header);

    if (subgroup.exercises.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" width="52" height="52"><path d="M6.5 6.5l11 11"/><path d="M2 8h4v8H2zM18 8h4v8h-4z"/><path d="M6 5v14M18 5v14"/></svg>' +
        '<h3>Nenhum exercício ainda</h3>' +
        '<p>Adicione os exercícios que fazem parte desse treino.</p>';
      mainView.appendChild(empty);
      return;
    }

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    const searchWrap = document.createElement('div');
    searchWrap.className = 'toolbar__search';
    searchWrap.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Buscar exercício…';
    searchInput.value = searchQuery;
    searchInput.addEventListener('input', (e) => { searchQuery = e.target.value; renderSubgroupView(group, subgroup); });
    searchWrap.appendChild(searchInput);
    toolbar.appendChild(searchWrap);

    const sortWrap = document.createElement('div');
    sortWrap.className = 'toolbar__sort';
    const sortLabel = document.createElement('label');
    sortLabel.textContent = 'Ordenar';
    sortWrap.appendChild(sortLabel);
    const sortSelect = document.createElement('select');
    [['time', 'Horário'], ['progress', 'Progresso'], ['name', 'Nome']].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = label;
      if (val === sortMode) opt.selected = true;
      sortSelect.appendChild(opt);
    });
    sortSelect.addEventListener('change', (e) => { sortMode = e.target.value; renderSubgroupView(group, subgroup); });
    sortWrap.appendChild(sortSelect);
    toolbar.appendChild(sortWrap);

    mainView.appendChild(toolbar);

    // Exercise list
    const list = document.createElement('section');
    list.className = 'exercise-list';
    const filtered = getFilteredSortedExercises(subgroup);

    if (filtered.length === 0) {
      const none = document.createElement('p');
      none.style.cssText = 'padding:24px 4px;color:var(--text-tertiary);font-size:13px;';
      none.textContent = 'Nenhum exercício corresponde à busca.';
      list.appendChild(none);
    } else {
      filtered.forEach((exercise) => {
        list.appendChild(buildExerciseCard(group, subgroup, exercise, dateKey));
      });
    }
    mainView.appendChild(list);
  }

  function buildExerciseCard(group, subgroup, exercise, dateKey) {
    const state = computeExerciseState(exercise, dateKey);

    const card = document.createElement('article');
    card.className = 'exercise-card' + (state.complete ? ' is-complete' : '');

    // Photo / placeholder
    if (exercise.photo) {
      const img = document.createElement('img');
      img.className = 'exercise-card__photo';
      img.src = exercise.photo;
      img.alt = exercise.name;
      img.addEventListener('click', () => openLightbox(exercise.photo));
      card.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'exercise-card__photo-placeholder';
      placeholder.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 16l-5-5-4 4-3-3-5 5"/></svg>';
      card.appendChild(placeholder);
    }

    const body = document.createElement('div');
    body.className = 'exercise-card__body';

    const top = document.createElement('div');
    top.className = 'exercise-card__top';
    const name = document.createElement('div');
    name.className = 'exercise-card__name';
    name.textContent = exercise.name;
    top.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'exercise-card__actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn--icon';
    editBtn.setAttribute('aria-label', 'Editar exercício');
    editBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    editBtn.addEventListener('click', () => openExerciseModal('edit', group.id, subgroup.id, exercise));
    actions.appendChild(editBtn);
    top.appendChild(actions);
    body.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'exercise-card__meta';
    if (exercise.time) {
      const timeSpan = document.createElement('span');
      timeSpan.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>';
      timeSpan.appendChild(document.createTextNode(exercise.time));
      meta.appendChild(timeSpan);
    }
    const setsSpan = document.createElement('span');
    setsSpan.textContent = `${exercise.sets} série${exercise.sets > 1 ? 's' : ''}`;
    meta.appendChild(setsSpan);
    if (exercise.videoUrl) {
      const videoLink = document.createElement('a');
      videoLink.href = exercise.videoUrl;
      videoLink.target = '_blank';
      videoLink.rel = 'noopener noreferrer';
      videoLink.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> Ver vídeo';
      meta.appendChild(videoLink);
    }
    body.appendChild(meta);

    if (exercise.notes) {
      const notes = document.createElement('p');
      notes.className = 'exercise-card__notes';
      notes.textContent = exercise.notes;
      body.appendChild(notes);
    }

    // Plate rack
    const rack = document.createElement('div');
    rack.className = 'plate-rack';
    for (let i = 0; i < exercise.sets; i++) {
      const plate = document.createElement('button');
      plate.type = 'button';
      plate.className = 'plate' + (state.arr[i] ? ' done' : '');
      plate.setAttribute('aria-label', `Série ${i + 1}${state.arr[i] ? ' concluída' : ''}`);
      plate.textContent = String(i + 1);
      plate.addEventListener('click', () => toggleSet(exercise.id, dateKey, i));
      rack.appendChild(plate);
    }
    body.appendChild(rack);

    card.appendChild(body);
    return card;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Lightbox
  // ---------------------------------------------------------------------

  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.classList.remove('hidden');
  }
  function closeLightbox() {
    lightbox.classList.add('hidden');
    lightboxImg.src = '';
  }
  lightbox.addEventListener('click', closeLightbox);

  // ---------------------------------------------------------------------
  // GROUP modal
  // ---------------------------------------------------------------------

  function openGroupModal(mode, group) {
    groupForm.reset();
    if (mode === 'edit' && group) {
      groupModalTitle.textContent = 'Editar grupo';
      editingGroupId = group.id;
      groupNameInput.value = group.name;
      deleteGroupBtn.classList.remove('hidden');
    } else {
      groupModalTitle.textContent = 'Novo grupo';
      editingGroupId = null;
      deleteGroupBtn.classList.add('hidden');
    }
    groupModal.classList.remove('hidden');
    setTimeout(() => groupNameInput.focus(), 50);
  }
  function closeGroupModal() { groupModal.classList.add('hidden'); }

  groupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = groupNameInput.value.trim();
    if (!name) { toast('Dê um nome ao grupo.', 'danger'); return; }

    if (editingGroupId) {
      const group = findGroup(editingGroupId);
      if (group) group.name = name;
      toast('Grupo atualizado.', 'success');
    } else {
      data.groups.push({ id: uid('grp'), name, createdAt: Date.now(), subgroups: [] });
      toast('Grupo criado.', 'success');
    }
    saveData();
    closeGroupModal();
    renderCurrentView();
  });

  $('closeGroupModalBtn').addEventListener('click', closeGroupModal);
  $('cancelGroupBtn').addEventListener('click', closeGroupModal);
  groupModal.addEventListener('click', (e) => { if (e.target === groupModal) closeGroupModal(); });
  deleteGroupBtn.addEventListener('click', () => {
    const group = findGroup(editingGroupId);
    if (!group) return;
    closeGroupModal();
    openConfirm(
      'Excluir grupo?',
      `"${group.name}" e todos os treinos e exercícios dentro dele serão excluídos permanentemente.`,
      () => {
        const exIds = [];
        group.subgroups.forEach((s) => s.exercises.forEach((ex) => exIds.push(ex.id)));
        data.groups = data.groups.filter((g) => g.id !== group.id);
        exIds.forEach(purgeExerciseFromProgress);
        saveData();
        navigate({ type: 'home' });
        toast('Grupo excluído.', 'danger');
      }
    );
  });

  // ---------------------------------------------------------------------
  // SUBGROUP (treino) modal
  // ---------------------------------------------------------------------

  function openSubgroupModal(mode, groupId, subgroup) {
    subgroupForm.reset();
    editingSubgroupGroupId = groupId;
    if (mode === 'edit' && subgroup) {
      subgroupModalTitle.textContent = 'Editar treino';
      editingSubgroupId = subgroup.id;
      subgroupNameInput.value = subgroup.name;
      deleteSubgroupBtn.classList.remove('hidden');
    } else {
      subgroupModalTitle.textContent = 'Novo treino';
      editingSubgroupId = null;
      deleteSubgroupBtn.classList.add('hidden');
    }
    subgroupModal.classList.remove('hidden');
    setTimeout(() => subgroupNameInput.focus(), 50);
  }
  function closeSubgroupModal() { subgroupModal.classList.add('hidden'); }

  subgroupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = subgroupNameInput.value.trim();
    if (!name) { toast('Dê um nome ao treino.', 'danger'); return; }
    const group = findGroup(editingSubgroupGroupId);
    if (!group) return;

    if (editingSubgroupId) {
      const subgroup = group.subgroups.find((s) => s.id === editingSubgroupId);
      if (subgroup) subgroup.name = name;
      toast('Treino atualizado.', 'success');
    } else {
      group.subgroups.push({ id: uid('sub'), name, createdAt: Date.now(), exercises: [] });
      toast('Treino criado.', 'success');
    }
    saveData();
    closeSubgroupModal();
    renderCurrentView();
  });

  $('closeSubgroupModalBtn').addEventListener('click', closeSubgroupModal);
  $('cancelSubgroupBtn').addEventListener('click', closeSubgroupModal);
  subgroupModal.addEventListener('click', (e) => { if (e.target === subgroupModal) closeSubgroupModal(); });
  deleteSubgroupBtn.addEventListener('click', () => {
    const group = findGroup(editingSubgroupGroupId);
    if (!group) return;
    const subgroup = group.subgroups.find((s) => s.id === editingSubgroupId);
    if (!subgroup) return;
    closeSubgroupModal();
    openConfirm(
      'Excluir treino?',
      `"${subgroup.name}" e todos os exercícios dentro dele serão excluídos permanentemente.`,
      () => {
        const exIds = subgroup.exercises.map((ex) => ex.id);
        group.subgroups = group.subgroups.filter((s) => s.id !== subgroup.id);
        exIds.forEach(purgeExerciseFromProgress);
        saveData();
        navigate({ type: 'group', groupId: group.id });
        toast('Treino excluído.', 'danger');
      }
    );
  });

  // ---------------------------------------------------------------------
  // EXERCISE modal
  // ---------------------------------------------------------------------

  function resetPhotoField() {
    pendingPhotoDataUrl = null;
    photoPreview.src = '';
    photoPreviewWrap.classList.add('hidden');
    photoUploadBtn.classList.remove('hidden');
  }

  function setPhotoField(dataUrl) {
    pendingPhotoDataUrl = dataUrl;
    if (dataUrl) {
      photoPreview.src = dataUrl;
      photoPreviewWrap.classList.remove('hidden');
      photoUploadBtn.classList.add('hidden');
    } else {
      resetPhotoField();
    }
  }

  function openExerciseModal(mode, groupId, subgroupId, exercise) {
    exerciseForm.reset();
    resetPhotoField();
    editingExerciseCtx = { groupId, subgroupId, exerciseId: mode === 'edit' && exercise ? exercise.id : null };

    if (mode === 'edit' && exercise) {
      exerciseModalTitle.textContent = 'Editar exercício';
      exerciseNameInput.value = exercise.name;
      exerciseSetsInput.value = exercise.sets;
      exerciseTimeInput.value = exercise.time || '';
      exerciseNotesInput.value = exercise.notes || '';
      exerciseVideoUrlInput.value = exercise.videoUrl || '';
      if (exercise.photo) setPhotoField(exercise.photo);
      deleteExerciseBtn.classList.remove('hidden');
    } else {
      exerciseModalTitle.textContent = 'Novo exercício';
      exerciseSetsInput.value = 4;
      deleteExerciseBtn.classList.add('hidden');
    }
    exerciseModal.classList.remove('hidden');
    setTimeout(() => exerciseNameInput.focus(), 50);
  }
  function closeExerciseModal() { exerciseModal.classList.add('hidden'); resetPhotoField(); }

  function purgeExerciseFromProgress(exerciseId) {
    Object.keys(data.progress).forEach((dateKey) => {
      const dayMap = data.progress[dateKey];
      if (dayMap && Object.prototype.hasOwnProperty.call(dayMap, exerciseId)) {
        delete dayMap[exerciseId];
        if (Object.keys(dayMap).length === 0) delete data.progress[dateKey];
      }
    });
  }

  function resizeExerciseProgress(exerciseId, newSets) {
    Object.keys(data.progress).forEach((dateKey) => {
      const dayMap = data.progress[dateKey];
      if (dayMap && dayMap[exerciseId]) {
        const old = dayMap[exerciseId];
        const resized = new Array(newSets).fill(false);
        for (let i = 0; i < Math.min(old.length, newSets); i++) resized[i] = old[i];
        dayMap[exerciseId] = resized;
      }
    });
  }

  exerciseForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { groupId, subgroupId, exerciseId } = editingExerciseCtx;
    const { subgroup } = findSubgroup(groupId, subgroupId);
    if (!subgroup) return;

    const name = exerciseNameInput.value.trim();
    const sets = Math.max(1, Math.min(20, parseInt(exerciseSetsInput.value, 10) || 1));
    const time = exerciseTimeInput.value || null;
    const notes = exerciseNotesInput.value.trim();
    const videoUrl = exerciseVideoUrlInput.value.trim();

    if (!name) { toast('Dê um nome ao exercício.', 'danger'); return; }

    if (exerciseId) {
      const exercise = subgroup.exercises.find((ex) => ex.id === exerciseId);
      if (exercise) {
        if (exercise.sets !== sets) resizeExerciseProgress(exerciseId, sets);
        exercise.name = name;
        exercise.sets = sets;
        exercise.time = time;
        exercise.notes = notes;
        exercise.videoUrl = videoUrl || null;
        exercise.photo = pendingPhotoDataUrl;
      }
      toast('Exercício atualizado.', 'success');
    } else {
      subgroup.exercises.push({
        id: uid('ex'),
        name, sets, time, notes,
        videoUrl: videoUrl || null,
        photo: pendingPhotoDataUrl,
        createdAt: Date.now(),
      });
      toast('Exercício adicionado.', 'success');
    }

    if (saveData()) {
      closeExerciseModal();
      renderCurrentView();
    }
  });

  $('closeExerciseModalBtn').addEventListener('click', closeExerciseModal);
  $('cancelExerciseBtn').addEventListener('click', closeExerciseModal);
  exerciseModal.addEventListener('click', (e) => { if (e.target === exerciseModal) closeExerciseModal(); });

  deleteExerciseBtn.addEventListener('click', () => {
    const { groupId, subgroupId, exerciseId } = editingExerciseCtx;
    const { subgroup } = findSubgroup(groupId, subgroupId);
    if (!subgroup) return;
    const exercise = subgroup.exercises.find((ex) => ex.id === exerciseId);
    if (!exercise) return;
    closeExerciseModal();
    openConfirm(
      'Excluir exercício?',
      `"${exercise.name}" e todo o progresso registrado serão removidos permanentemente.`,
      () => {
        subgroup.exercises = subgroup.exercises.filter((ex) => ex.id !== exerciseId);
        purgeExerciseFromProgress(exerciseId);
        saveData();
        renderCurrentView();
        toast('Exercício excluído.', 'danger');
      }
    );
  });

  // ---------------------------------------------------------------------
  // Photo upload — resized client-side before being stored
  // ---------------------------------------------------------------------

  photoUploadBtn.addEventListener('click', () => exercisePhotoInput.click());
  photoRemoveBtn.addEventListener('click', () => setPhotoField(null));

  exercisePhotoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    resizeImageFile(file, 640, 0.72)
      .then((dataUrl) => setPhotoField(dataUrl))
      .catch(() => toast('Não foi possível carregar essa imagem.', 'danger'));
    e.target.value = '';
  });

  function resizeImageFile(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('invalid image'));
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
            else { width = Math.round(width * (maxDim / height)); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------------------------------------------------------------------
  // Confirm modal
  // ---------------------------------------------------------------------

  function openConfirm(title, message, onConfirm) {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    confirmModal.classList.remove('hidden');
  }
  function closeConfirm() { confirmModal.classList.add('hidden'); confirmCallback = null; }

  $('confirmCancelBtn').addEventListener('click', closeConfirm);
  $('confirmOkBtn').addEventListener('click', () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
  });
  confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) closeConfirm(); });

  // ---------------------------------------------------------------------
  // Top "+" button — behavior depends on current view
  // ---------------------------------------------------------------------

  addBtn.addEventListener('click', () => {
    if (view.type === 'home') openGroupModal('create');
    else if (view.type === 'group') openSubgroupModal('create', view.groupId);
    else if (view.type === 'subgroup') openExerciseModal('create', view.groupId, view.subgroupId);
  });

  // ---------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------

  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forja-backup-${todayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Dados exportados.', 'success');
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());

  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.groups) || typeof parsed.progress !== 'object') {
          throw new Error('Formato inválido');
        }
        openConfirm(
          'Importar dados?',
          'Isso substituirá todos os grupos, treinos e progresso atuais pelos do arquivo importado.',
          () => {
            data = { groups: parsed.groups, progress: parsed.progress || {} };
            saveData();
            navigate({ type: 'home' });
            toast('Dados importados com sucesso.', 'success');
          }
        );
      } catch (err) {
        toast('Arquivo inválido. Verifique o backup e tente novamente.', 'danger');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ---------------------------------------------------------------------
  // Keyboard: Esc closes modals / lightbox
  // ---------------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!lightbox.classList.contains('hidden')) { closeLightbox(); return; }
    if (!exerciseModal.classList.contains('hidden')) { closeExerciseModal(); return; }
    if (!subgroupModal.classList.contains('hidden')) { closeSubgroupModal(); return; }
    if (!groupModal.classList.contains('hidden')) { closeGroupModal(); return; }
    if (!confirmModal.classList.contains('hidden')) { closeConfirm(); return; }
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  function init() {
    currentDateEl.textContent = formatFullDate(new Date());
    renderCurrentView();
  }

  init();
})();
