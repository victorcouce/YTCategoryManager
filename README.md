# 📂 YouTube Category Manager

Extensión de Chrome (Manifest V3) que organiza tus suscripciones de YouTube en categorías personalizadas directamente en el sidebar.

## ✨ Funcionalidades

- **Sidebar con categorías** — acordeón colapsable integrado en el sidebar de YouTube con los canales agrupados por categoría
- **Panel de organización** — modal flotante con todos tus canales suscritos para asignarlos a categorías de forma rápida
- **Filtrado por categoría** — haz clic en una categoría para ver solo los canales de esa categoría
- **Búsqueda** — filtra canales por nombre en tiempo real, combinable con el filtro de categoría
- **Ordenación** — por actividad reciente (último vídeo publicado) o alfabética A→Z
- **Fecha del último vídeo** — visible en cada card, cargada de forma perezosa vía feed RSS
- **Punto azul** — indica canales con vídeos nuevos sin ver desde tu última visita
- **Crear y eliminar categorías** — directamente desde el panel, con nombre, emoji y color
- **Asignación masiva** — modo multi-selección para asignar varios canales a una categoría a la vez
- **Abrir canal** — clic en la card abre el canal en una pestaña nueva
- **Dark mode** — compatible con el tema oscuro de YouTube

## 🚀 Instalación

1. Clona o descarga este repositorio
2. Abre Chrome y ve a `chrome://extensions`
3. Activa el **Modo desarrollador** (esquina superior derecha)
4. Haz clic en **Cargar descomprimida** y selecciona la carpeta del proyecto
5. Navega a [youtube.com](https://www.youtube.com) — el sidebar y el botón del panel aparecerán automáticamente

## 🗂 Estructura del proyecto

```
├── manifest.json       # Configuración de la extensión (MV3)
├── content.js          # Controlador principal — ciclo de vida e inyección
├── sidebar.js          # Sidebar con categorías acordeón
├── sidebar.css         # Estilos del sidebar y del panel
├── panel.js            # Panel flotante de organización masiva
├── storage.js          # Capa de abstracción sobre chrome.storage
├── background.js       # Service worker
├── popup.html/js/css   # Popup de la extensión (configuración básica)
└── _locales/           # Internacionalización (en / es)
```

## 🔧 Permisos

| Permiso | Motivo |
|---|---|
| `storage` | Guardar categorías, asignaciones y configuración |
| `host_permissions: youtube.com` | Inyectar el sidebar y el panel en YouTube |

No se solicitan permisos de lectura de historial, cookies ni datos sensibles.

## 🛠 Desarrollo

Los archivos se cargan directamente como content scripts, sin bundler. Cualquier cambio en los archivos requiere recargar la extensión en `chrome://extensions`.

Para validar la sintaxis de JavaScript:

```bash
node --check panel.js
node --check sidebar.js
node --check storage.js
```

## 📝 Notas técnicas

- **Fetch de suscripciones** — se obtienen via `fetch('/feed/channels')` parseando `ytInitialData`, lo que garantiza la lista completa sin depender del DOM del sidebar
- **Fechas de último vídeo** — se consultan en paralelo (máx. 15 peticiones) via feed RSS de YouTube (`/feeds/videos.xml?channel_id=...`)
- **Caché en memoria** — `storage.js` usa un caché en memoria para evitar lecturas repetidas a `chrome.storage`
- **IDs canónicos** — migración automática de IDs legacy (`/@handle`) a IDs canónicos (`UCxxxxx`) al abrir el panel

## 📄 Licencia

MIT
