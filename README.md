# ShopSphere Store

A small online store demo built with Flask, SQLite, HTML, CSS, and JavaScript.

Registered users can list products from the **Sell a product** dashboard. Listings include a category, rupee price, stock quantity, description, and optional HTTPS image URL. Buyers can add available items to their cart and submit an order; sellers can view the items, buyer contact details, and delivery address for orders containing their products.

**Payments and delivery are not integrated.** Checkout only records an unpaid demo order; it does not charge a customer or arrange shipping. Buyers and sellers must arrange payment and delivery themselves. Do not treat this demo as a live marketplace or enter sensitive payment details.

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

## Deploy a free demo on Render

1. Open the [Render deployment setup](https://render.com/deploy?repo=https://github.com/harshitbisht383/CodeAlpha_Shopsphere-store).
2. Sign in to Render and authorize access to this GitHub repository.
3. Review the `shopsphere-store` web service settings from `render.yaml`, then create the service.
4. When Render finishes deploying, open the `onrender.com` URL shown on the service page.

The free demo uses SQLite under `/tmp`. Its accounts, seller listings, carts, and orders are temporary and can be lost when the service restarts or redeploys. This app does not collect payment or arrange delivery. Use a persistent database and payment provider before handling real customers or orders.

## Run tests

```powershell
python -m unittest -v
```
