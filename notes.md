TODO:
 - [x] ...
 - [x] lookup views
 - [x] autofix
 - [x] inserts
 - [x] epilogue
 - [x] fragments
 - [x] load all views before initialization (or load on demand. feels buggy on cross-file reference).
 - [x] test on medflyt_server2
 - [x] cleanup
    - [x] monorepo - split to multiple packages [core, client, eslint-plugin, demo]
    - [x] setup dev mode
    - [x] setup build mode
    - [x] load config ones. no duplicate settings (e.g. migrationsDir)
    - [x] postgresVersion?
 - [x] tests
 - [x] publish as separate package
 - [x] publish as new repository
 - [ ] ci
 - [ ] cd

 views are not working properly:
  - initial with error, should throw both on terminal and ide
  - on fix error in ide, should be fixed fast



## had to run in on mac (m1)
http://willbryant.net/software/mac_os_x/postgres_initdb_fatal_shared_memory_error_on_leopard

➜  ✗ sudo sysctl -w kern.sysv.shmall=65536

kern.sysv.shmall: 1024 -> 65536
➜  ✗ sudo sysctl -w kern.sysv.shmmax=16777216

kern.sysv.shmmax: 4194304 -> 16777216
