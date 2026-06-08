# Timeweb deploy notes

If the site logs `SQLITE_READONLY` or `attempt to write a readonly database`, SQLite cannot write to the database file or to the directory that contains it.

## Required writable paths

SQLite needs write access to:

- `worktap.db`
- the directory containing `worktap.db`

The directory must be writable because SQLite creates temporary journal files near the database.

Chat uploads also need a writable directory:

- `public/uploads/chat`

## Recommended Timeweb setup

1. Put `worktap.db` into a writable app data directory, for example:

   ```text
   /home/<user>/worktap-data/worktap.db
   ```

2. In the Node app environment variables set:

   ```text
   WORKTAP_DB_PATH=/home/<user>/worktap-data/worktap.db
   WORKTAP_UPLOAD_DIR=/home/<user>/<site-folder>/public/uploads
   ```

3. Set permissions on the server:

   ```bash
   chmod 755 /home/<user>/worktap-data
   chmod 664 /home/<user>/worktap-data/worktap.db
   chmod -R 755 /home/<user>/<site-folder>/public/uploads
   ```

   If Timeweb runs Node under a different user, set the owner in the hosting file manager or via SSH so the Node app user owns these paths.

4. Restart the Node app from the Timeweb panel.

## What changed in the app

The app now opens SQLite by absolute path:

- `WORKTAP_DB_PATH`, if it is set
- otherwise `<project-folder>/worktap.db`

On startup the app logs the exact database path, so check the Timeweb logs after restart.
