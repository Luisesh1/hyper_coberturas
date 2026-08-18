# Flujo de git

Este proyecto usa un flujo simple de tres niveles. Léelo antes de empezar a
trabajar, sobre todo si sos un agente (Claude Code u otro) operando en este
repo — es común tener varias sesiones trabajando en paralelo sobre el mismo
código, y este flujo existe para que no se pisen entre sí.

## Ramas

- **`main`** — producción. Cada push a `main` dispara CI y, si pasa, un
  deploy automático al servidor de producción (ver `.github/workflows/deploy.yml`
  y [DEPLOYMENT.md](DEPLOYMENT.md)). No se trabaja directo acá. Solo recibe
  merges desde `develop`, y solo cuando alguien decide conscientemente
  promover a producción.
- **`develop`** — rama de integración. Es la base de todo el trabajo diario.
  Debe mantenerse razonablemente estable (tests en verde) porque varios
  agentes parten de acá en paralelo — un `develop` roto rompe el punto de
  partida de todos.
- **`feature/<slug>`** / **`fix/<slug>`** — una rama por tarea, creada desde
  `develop`. Cada agente o persona trabaja aislado en la suya: podés
  commitear, experimentar y romper cosas ahí sin afectar a nadie más.

## Ciclo de trabajo

1. Arrancá siempre desde `develop` actualizado:
   ```bash
   git checkout develop
   git pull
   git checkout -b feature/nombre-de-la-tarea
   ```
2. Trabajá y commiteá normalmente en tu rama.
3. Antes de mergear, traé los cambios que otros agentes ya mandaron a
   `develop` y corré los tests localmente:
   ```bash
   git pull origin develop
   ```
4. Mergeá tu rama a `develop` (merge directo o PR — no hace falta revisión
   manual obligatoria, pero sí tests en verde):
   ```bash
   git checkout develop
   git merge feature/nombre-de-la-tarea
   git push
   ```
5. Borrá la rama de feature una vez mergeada:
   ```bash
   git branch -d feature/nombre-de-la-tarea
   git push origin --delete feature/nombre-de-la-tarea  # si la habías pusheado
   ```

## Promoción a producción

Cuando `develop` está en un estado listo para desplegar, alguien lo decide
explícitamente y promueve:

```bash
git checkout main
git merge develop
git push
```

Ese push a `main` es lo que dispara CI y el deploy automático. No pasa
solo — siempre es una decisión consciente.

## CI

`.github/workflows/ci.yml` corre lint y tests en push/PR tanto a `main`
como a `develop`, para que cualquier agente vea si rompió algo antes de
mergear. El deploy (`deploy.yml`) sigue atado únicamente a `main`.

## Por qué rama por tarea (y no commitear directo a develop)

Con varios agentes trabajando en paralelo sobre este repo, commitear directo
a `develop` genera pushes que chocan entre sí y, peor, puede dejar a todos
los demás agentes heredando un `develop` roto a mitad de una tarea ajena.
Trabajar en una rama propia por tarea aísla el trabajo en progreso: si algo
sale mal, se descarta esa rama sin afectar a nadie.
