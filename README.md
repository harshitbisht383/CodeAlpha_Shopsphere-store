# ShopSphere Store

A small online store demo built with Flask, SQLite, HTML, CSS, and JavaScript.

## Requirements

- Python 3.10 or newer
- pip

## Run locally

Open a terminal in this project folder and run:

```powershell
python -m pip install -r requirements.txt
python app.py
```

Open <http://127.0.0.1:8000/> in your browser. Keep the terminal running while you use the store.

The SQLite database is created locally when the app starts. It is intentionally excluded from Git; the product catalog is loaded from `products.json`.

## Run tests

```powershell
python -m unittest -v
```
