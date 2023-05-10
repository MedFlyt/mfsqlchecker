http://willbryant.net/software/mac_os_x/postgres_initdb_fatal_shared_memory_error_on_leopard

➜  mfsqlchecker git:(feature-mfsqlchecker-eslint) ✗ sudo sysctl -w kern.sysv.shmall=65536

kern.sysv.shmall: 1024 -> 65536
➜  mfsqlchecker git:(feature-mfsqlchecker-eslint) ✗ sudo sysctl -w kern.sysv.shmmax=16777216

kern.sysv.shmmax: 4194304 -> 16777216