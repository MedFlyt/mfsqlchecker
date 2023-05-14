http://willbryant.net/software/mac_os_x/postgres_initdb_fatal_shared_memory_error_on_leopard

➜  mfsqlchecker git:(feature-mfsqlchecker-eslint) ✗ sudo sysctl -w kern.sysv.shmall=65536

kern.sysv.shmall: 1024 -> 65536
➜  mfsqlchecker git:(feature-mfsqlchecker-eslint) ✗ sudo sysctl -w kern.sysv.shmmax=16777216

kern.sysv.shmmax: 4194304 -> 16777216


TODO:
 - lookup views
 - autofix
 - inserts
 - epilogue



<!-- make sure to add it to the worker -->
```
const [updated, newViewNames] = await updateViews(this.client, manifest.strictDateTimeChecking, this.viewNames, manifest.viewLibrary);

if (updated) {
    await this.tableColsLibrary.refreshViews(this.client);
}

this.viewNames = newViewNames;

for (const [viewName, viewAnswer] of this.viewNames) {
    const createView = manifest.viewLibrary.find(x => x.viewName === viewName);
    if (createView === undefined) {
        throw new Error("The Impossible Happened");
    }
    queryErrors = queryErrors.concat(viewAnswerToErrorDiagnostics(createView, viewAnswer));
}
```