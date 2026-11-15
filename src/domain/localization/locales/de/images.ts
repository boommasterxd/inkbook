export const images = {
  "canvas.kind_image": "Bild",
  "editor.action.image": "Bild oder PDF einfügen",
  "editor.action.crop-image": "Bild zuschneiden",
  "images.import": "Bild oder PDF einfügen",
  "images.choose": "Bild oder PDF auswählen",
  "images.formats": "PNG, JPG, WebP oder PDF · Bis 16 MiB",
  "images.change": "Ändern",
  "images.pageCount": "PDF · {count} Seiten",
  "images.singlePage": "PDF · 1 Seite",
  "images.pages": "PDF-Seiten",
  "images.pagesHint": "Bis zu 20 Seiten, z. B. 1, 3-5. Einfügen in Dokumentreihenfolge.",
  "images.previewHint": "Prüfe, ob die Vorschau dem Original entspricht.",
  "images.previewPage": "Vorschauseite",
  "images.quality": "PDF-Auflösung",
  "images.standard": "Standard · bis 72 dpi",
  "images.high": "Hoch · bis 144 dpi",
  "images.preview": "Bildvorschau",
  "images.preparing": "Bild wird vorbereitet…",
  "images.preparingPage": "Seite {page} von {total} wird vorbereitet…",
  "images.details": "{width} × {height} Pixel",
  "images.resized":
    "Automatisch von {sourceWidth} × {sourceHeight} auf {width} × {height} Pixel verkleinert. Die Originaldatei bleibt unverändert.",
  "images.failure": "Die Datei konnte nicht importiert werden. Versuche eine andere Datei.",
  "images.failureSourceSize": "Die Datei ist größer als 16 MiB. Wähle eine kleinere Datei.",
  "images.failureSourceRead": "Die Datei ist leer oder nicht lesbar. Wähle sie erneut aus.",
  "images.failureDimensions":
    "Das Quellbild überschreitet 32 Megapixel oder 16.384 Pixel pro Kante. Verkleinere es und versuche es erneut.",
  "images.failureDecode":
    "Das Bild konnte nicht dekodiert werden. Speichere es erneut als PNG, JPEG oder statisches WebP und versuche es noch einmal.",
  "images.failureEncodedSize":
    "Das aufbereitete Bild ist größer als 8 MiB. Verkleinere es und versuche es erneut.",
  "images.failurePages":
    "Wähle gültige PDF-Seiten, z. B. 1, 3-5. Höchstens 20 Seiten sind möglich.",
  "images.failureCapacity":
    "Diese Seiten überschreiten die Bildkapazität der Zeichnung. Wähle weniger Seiten.",
  "images.failureFormat":
    "Die Datei ist kein unterstütztes PNG, JPEG, statisches WebP oder PDF. Wähle eine andere Datei.",
  "images.insert": "Einfügen",
  "images.cancel": "Abbrechen",
  "images.crop": "Bild zuschneiden",
  "images.cropHint":
    "Zuschnittkanten ziehen oder den Ausschnitt verschieben. Pfeiltasten ändern einen Pixel, mit Umschalt zehn. Pos1 stellt das vollständige Bild wieder her. Eingabe übernimmt; Escape bricht ab.",
  "images.moveCrop": "Ausschnitt verschieben. Ziehen oder Pfeiltasten verwenden.",
  "images.handle": "Zuschnittgriff: {edges}. Ziehen oder Pfeiltasten verwenden.",
  "images.cropNotice":
    "Zuschneiden blendet Pixel aus. Das vollständige importierte Bild bleibt eingebettet und kann wiederhergestellt werden. Vertrauliche Inhalte werden dadurch nicht sicher entfernt.",
  "images.left": "Linke Kante",
  "images.top": "Obere Kante",
  "images.right": "Rechte Kante",
  "images.bottom": "Untere Kante",
  "images.reset": "Vollständiges Bild wiederherstellen",
  "images.apply": "Zuschnitt anwenden",
} as const;
