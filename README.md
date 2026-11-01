<div align="center">
  <img src="images/ovi-git-banner.png" alt="Ovi Git" width="100%">
</div>

# Ovi Git

Visualiza el historial de Git y trabaja con ramas, commits, etiquetas y stashes sin salir de Visual Studio Code.

Ovi Git convierte el historial de cualquier repositorio del espacio de trabajo en un gráfico compacto e interactivo. La extensión utiliza tu instalación local de Git: no envía el contenido del repositorio a servicios externos.

<div align="center">
  <img src="images/graph-preview.png" alt="Vista previa del gráfico de Ovi Git" width="100%">
</div>

## Características

- Historial gráfico con ramas, merges y posición actual de `HEAD`.
- Referencias locales, remotas y etiquetas junto a cada commit.
- Búsqueda por mensaje, autor, correo, hash o nombre de rama.
- Panel de detalle con autor, fecha, cuerpo del commit y archivos modificados.
- Comparación de cada archivo con su versión anterior mediante el visor diff de VS Code.
- Indicador de cambios sin confirmar y acceso rápido a Control de código fuente.
- Historial paginado para trabajar con repositorios grandes.

## Operaciones Git

| Elemento | Acciones disponibles |
| --- | --- |
| Commit | Crear rama o etiqueta, checkout separado, cherry-pick, revert, reset y copiar hash |
| Rama local | Checkout, merge, crear rama, eliminar y copiar nombre |
| Rama remota | Crear rama local, merge, eliminar del remoto y copiar nombre |
| Etiqueta | Eliminar y copiar nombre |
| Stash | Aplicar, pop, crear rama y eliminar |
| Cambios locales | Guardar en stash o abrir Control de código fuente |

Las operaciones destructivas solicitan confirmación antes de ejecutarse.

## Uso

1. Abre en VS Code una carpeta que pertenezca a un repositorio Git.
2. Abre la paleta de comandos con `Cmd+Shift+P` en macOS o `Ctrl+Shift+P` en Windows y Linux.
3. Ejecuta **Ovi Git: Abrir gráfico**.
4. Selecciona un commit para consultar sus detalles.
5. Haz clic sobre una rama o etiqueta para ver sus acciones, o abre el menú contextual de un commit.

También puedes abrir Ovi Git desde el botón de gráfico situado en el encabezado de Control de código fuente.

## Instalación desde un VSIX

Genera el paquete instalable:

```bash
npm install
npx @vscode/vsce package
```

Después, abre **Extensiones**, selecciona el menú `...`, elige **Instalar desde VSIX...** y abre el archivo `ovi-git-*.vsix` generado.

## Requisitos

- Visual Studio Code 1.85 o posterior.
- Git 2.23 o posterior disponible en `PATH`.
- Una carpeta de trabajo que pertenezca a un repositorio Git.

## Desarrollo

```bash
npm install
npm run compile
```

Pulsa `F5` y selecciona **Ejecutar extensión** para abrir una ventana de Extension Development Host. Durante el desarrollo puedes mantener activa la compilación incremental:

```bash
npm run watch
```

## Privacidad

Ovi Git ejecuta el binario local de Git con las credenciales y la configuración de tu equipo. La extensión no incluye telemetría y no transmite el historial ni los archivos del repositorio.

## Licencia

Publicado bajo la [licencia MIT](LICENSE).