import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useTradingContext } from '../../context/TradingContext';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog';
import { usersApi } from '../../services/api';
import { EmptyState } from '../../components/shared/EmptyState';
import UserFormModal from './components/UserFormModal';
import styles from './UsersPage.module.css';

const FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'active', label: 'Activos' },
  { key: 'inactive', label: 'Inactivos' },
  { key: 'superuser', label: 'Superusuarios' },
];

function UserCard({ user, currentUserId, onEdit, onToggleRole, onToggleActive, busy }) {
  const isSelf = user.id === currentUserId;
  const initials = (user.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2);

  return (
    <div className={`${styles.card} ${!user.active ? styles.cardInactive : ''} ${isSelf ? styles.cardSelf : ''}`}>
      <div className={styles.cardTop}>
        <div className={styles.avatar}>{initials}</div>
        <div className={styles.cardInfo}>
          <h4 className={styles.cardName}>
            {user.name}
            {isSelf && <span className={styles.selfBadge}>tu</span>}
          </h4>
          <p className={styles.cardUsername}>@{user.username}</p>
        </div>
      </div>

      <div className={styles.cardMeta}>
        <span className={`${styles.badge} ${user.role === 'superuser' ? styles.badgeSu : styles.badgeUser}`}>
          {user.role === 'superuser' ? 'Superusuario' : 'Usuario'}
        </span>
        <span className={`${styles.badge} ${user.active ? styles.badgeActive : styles.badgeInactive}`}>
          {user.active ? 'Activo' : 'Inactivo'}
        </span>
        <span className={styles.cardDate}>
          {new Date(user.createdAt).toLocaleDateString()}
        </span>
      </div>

      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => onEdit(user)}
          disabled={busy}
        >
          Editar
        </button>
        {!isSelf && (
          <>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => onToggleRole(user)}
              disabled={busy}
              title={user.role === 'superuser' ? 'Cambiar a usuario' : 'Promover a superusuario'}
            >
              {user.role === 'superuser' ? 'Quitar SU' : 'Hacer SU'}
            </button>
            <button
              type="button"
              className={`${styles.actionBtn} ${user.active ? styles.actionDanger : styles.actionSuccess}`}
              onClick={() => onToggleActive(user)}
              disabled={busy}
            >
              {user.active ? 'Desactivar' : 'Activar'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const { addNotification } = useTradingContext();
  const { dialog, confirm } = useConfirmAction();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [modalUser, setModalUser] = useState(undefined); // undefined=closed, null=create, object=edit

  const load = useCallback(() => {
    setLoading(true);
    usersApi.getAll()
      .then(setUsers)
      .catch((err) => addNotification('error', `Error al cargar usuarios: ${err.message}`))
      .finally(() => setLoading(false));
  }, [addNotification]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let list = users;
    if (filter === 'active') list = list.filter((u) => u.active);
    if (filter === 'inactive') list = list.filter((u) => !u.active);
    if (filter === 'superuser') list = list.filter((u) => u.role === 'superuser');
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((u) =>
        u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q),
      );
    }
    return list;
  }, [users, filter, search]);

  const activeCount = useMemo(() => users.filter((u) => u.active).length, [users]);

  const handleSave = useCallback(async (form, existingUser) => {
    if (existingUser?.id) {
      const payload = { name: form.name.trim() };
      if (form.password) payload.password = form.password;
      const updated = await usersApi.update(existingUser.id, payload);
      setUsers((prev) => prev.map((u) => u.id === updated.id ? updated : u));
      addNotification('success', `Usuario "${updated.name}" actualizado`);
    } else {
      const created = await usersApi.create({
        username: form.username.trim(),
        password: form.password,
        name: form.name.trim(),
        role: form.role,
      });
      setUsers((prev) => [...prev, created]);
      addNotification('success', `Usuario "${created.name}" creado`);
    }
  }, [addNotification]);

  const handleToggleRole = useCallback(async (user) => {
    const newRole = user.role === 'superuser' ? 'user' : 'superuser';
    const label = newRole === 'superuser' ? 'Promover a superusuario' : 'Cambiar a usuario';
    const ok = await confirm({
      title: label,
      message: `¿${label} a "${user.name}" (@${user.username})?`,
      confirmLabel: label,
    });
    if (!ok) return;

    setBusy(true);
    try {
      const updated = await usersApi.setRole(user.id, newRole);
      setUsers((prev) => prev.map((u) => u.id === updated.id ? updated : u));
      addNotification('success', `Rol de "${updated.name}" cambiado a ${newRole}`);
    } catch (err) {
      addNotification('error', err.message);
    } finally {
      setBusy(false);
    }
  }, [confirm, addNotification]);

  const handleToggleActive = useCallback(async (user) => {
    const action = user.active ? 'Desactivar' : 'Activar';
    const ok = await confirm({
      title: `${action} usuario`,
      message: user.active
        ? `¿Desactivar a "${user.name}"? No podra iniciar sesion.`
        : `¿Reactivar a "${user.name}"?`,
      confirmLabel: action,
      danger: user.active,
    });
    if (!ok) return;

    setBusy(true);
    try {
      const updated = await usersApi.setActive(user.id, !user.active);
      setUsers((prev) => prev.map((u) => u.id === updated.id ? updated : u));
      addNotification('success', `"${updated.name}" ${updated.active ? 'activado' : 'desactivado'}`);
    } catch (err) {
      addNotification('error', err.message);
    } finally {
      setBusy(false);
    }
  }, [confirm, addNotification]);

  return (
    <div className={styles.page}>
      {/* Hero */}
      <div className={styles.hero}>
        <div className={styles.heroLeft}>
          <span className={styles.eyebrow}>Administracion</span>
          <h1 className={styles.title}>Usuarios</h1>
        </div>

        <div className={styles.heroRight}>
          <div className={styles.stat}>
            <strong>{users.length}</strong>
            <span>Total</span>
          </div>
          <div className={`${styles.stat} ${styles.statGreen}`}>
            <strong>{activeCount}</strong>
            <span>Activos</span>
          </div>
          <button type="button" className={styles.addBtn} onClick={() => setModalUser(null)}>
            + Nuevo usuario
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon}>&#x1F50D;</span>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="Buscar por nombre o usuario..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className={styles.filterGroup}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`${styles.filterBtn} ${filter === f.key ? styles.filterBtnActive : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className={styles.empty}>Cargando usuarios...</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={search || filter !== 'all' ? '🔍' : '👥'}
          title={search || filter !== 'all' ? 'Sin resultados' : 'No hay usuarios'}
          description={search || filter !== 'all'
            ? 'Intenta con otro filtro o busqueda.'
            : 'Crea el primer usuario para comenzar.'}
          action={!(search || filter !== 'all') ? '+ Nuevo usuario' : undefined}
          onAction={!(search || filter !== 'all') ? () => setModalUser(null) : undefined}
        />
      ) : (
        <div className={styles.grid}>
          {filtered.map((u) => (
            <UserCard
              key={u.id}
              user={u}
              currentUserId={currentUser?.userId}
              onEdit={setModalUser}
              onToggleRole={handleToggleRole}
              onToggleActive={handleToggleActive}
              busy={busy}
            />
          ))}
        </div>
      )}

      {/* Modal */}
      {modalUser !== undefined && (
        <UserFormModal
          user={modalUser}
          onSave={handleSave}
          onClose={() => setModalUser(undefined)}
        />
      )}

      {/* Confirm dialog */}
      {dialog && <ConfirmDialog {...dialog} />}
    </div>
  );
}
