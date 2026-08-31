// JXA bridge to Apple Notes. Invoked as:
//   osascript -l JavaScript notes.js /path/to/payload.json
// Reads a JSON op from the file, prints a JSON result to stdout. Passing the payload as a
// file rather than argv keeps note bodies (which contain quotes and newlines) off the
// command line entirely.
ObjC.import('Foundation');

function readFile(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
  return ObjC.unwrap(s);
}

// osascript sends console.log to stderr; only the value returned from run() reaches
// stdout, so every path here returns its JSON string rather than logging it.
function ok(data) {
  return JSON.stringify({ ok: true, data: data });
}

function fail(message) {
  return JSON.stringify({ ok: false, error: String(message) });
}

function run(argv) {
  try {
    const payload = JSON.parse(readFile(argv[0]));
    const Notes = Application('Notes');
    Notes.includeStandardAdditions = false;

    switch (payload.op) {
      case 'list': {
        // Walking accounts -> folders costs a handful of Apple Events; asking 300+ notes
        // for their container individually costs 300+ and returns null in bulk form.
        const out = [];
        for (const account of Notes.accounts()) {
          const accountName = account.name();
          for (const folder of account.folders()) {
            const folderName = folder.name();
            const ids = folder.notes.id();
            const names = folder.notes.name();
            const modified = folder.notes.modificationDate();
            for (let i = 0; i < ids.length; i++) {
              out.push({
                id: ids[i],
                name: names[i] || '',
                folder: folderName,
                account: accountName,
                updatedAt: modified[i] ? modified[i].toISOString() : '',
              });
            }
          }
        }
        out.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
        return ok(out);
      }

      case 'get': {
        const note = Notes.notes.byId(payload.id);
        return ok({ id: note.id(), name: note.name(), body: note.body() });
      }

      case 'getMany': {
        const out = [];
        for (const id of payload.ids) {
          try {
            const note = Notes.notes.byId(id);
            out.push({ id: note.id(), name: note.name(), body: note.body() });
          } catch (e) {
            // A note deleted between listing and reading is not an error worth failing on.
          }
        }
        return ok(out);
      }

      case 'create': {
        let target;
        if (payload.folder) {
          target = findFolder(Notes, payload.folder);
          if (!target) return fail('No Apple Notes folder named "' + payload.folder + '"');
        } else {
          target = Notes.defaultAccount.defaultFolder();
        }
        const note = Notes.Note({ body: payload.html });
        target.notes.push(note);
        return ok({ id: note.id(), name: note.name() });
      }

      case 'setBody': {
        const note = Notes.notes.byId(payload.id);
        note.body = payload.html;
        return ok({ id: payload.id, name: note.name() });
      }

      default:
        return fail('Unknown op: ' + payload.op);
    }
  } catch (e) {
    return fail(e.message || e);
  }
}

function findFolder(Notes, wanted) {
  const target = String(wanted).toLowerCase();
  const accounts = Notes.accounts();
  for (const account of accounts) {
    const folders = account.folders();
    for (const folder of folders) {
      if (String(folder.name()).toLowerCase() === target) return folder;
    }
  }
  return null;
}
