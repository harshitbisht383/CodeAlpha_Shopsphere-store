import tempfile
import unittest
from pathlib import Path

import app as shopsphere
from werkzeug.security import check_password_hash


class ShopSphereApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        shopsphere.DATABASE_PATH = Path(self.temp_dir.name) / "test.sqlite3"
        shopsphere.app.config.update(TESTING=True, SECRET_KEY="test-secret")
        shopsphere.init_database()
        self.client = shopsphere.app.test_client()
        bootstrap = self.client.get("/api/bootstrap")
        self.assertEqual(bootstrap.status_code, 200)
        self.csrf_token = bootstrap.get_json()["csrfToken"]

    def tearDown(self):
        self.temp_dir.cleanup()

    def request_json(self, method, path, body=None, csrf=True):
        headers = {"X-CSRF-Token": self.csrf_token} if csrf else {}
        return self.client.open(
            path,
            method=method,
            json=body,
            headers=headers,
        )

    def query_one(self, statement, parameters=()):
        database = shopsphere.connect_database()
        try:
            return database.execute(statement, parameters).fetchone()
        finally:
            database.close()

    def register(self):
        response = self.request_json(
            "POST",
            "/api/register",
            {
                "username": "ajay-demo",
                "email": "ajay@example.com",
                "password": "correct horse battery",
            },
        )
        if response.status_code == 201:
            self.csrf_token = response.get_json()["csrfToken"]
        return response

    def test_catalog_and_csrf_protection(self):
        bootstrap = self.client.get("/api/bootstrap").get_json()
        self.assertEqual(len(bootstrap["products"]), 50)
        response = self.request_json(
            "POST",
            "/api/cart",
            {"productId": "wireless-headphones"},
            csrf=False,
        )
        self.assertEqual(response.status_code, 400)

    def test_guest_cart_uses_server_product_price_and_merges_on_register(self):
        add_response = self.request_json(
            "POST",
            "/api/cart",
            {"productId": "wireless-headphones", "price": 1},
        )
        self.assertEqual(add_response.status_code, 200)
        item = add_response.get_json()["cart"]["items"][0]
        self.assertEqual(item["price"], 1999)

        register_response = self.register()
        self.assertEqual(register_response.status_code, 201)
        self.assertEqual(
            register_response.get_json()["user"]["username"],
            "ajay-demo",
        )
        user_cart = self.client.get("/api/cart").get_json()
        self.assertEqual(user_cart["count"], 1)
        self.assertEqual(user_cart["total"], 1999)

        row = self.query_one(
            "SELECT password_hash FROM users WHERE username = ?",
            ("ajay-demo",),
        )
        self.assertTrue(check_password_hash(row["password_hash"], "correct horse battery"))
        self.assertNotEqual(row["password_hash"], "correct horse battery")

    def test_checkout_persists_order_items_and_opted_in_location(self):
        self.assertEqual(self.register().status_code, 201)
        self.request_json(
            "POST",
            "/api/cart",
            {"productId": "desk-plant-pot", "quantity": 2},
        )
        response = self.request_json(
            "POST",
            "/api/checkout",
            {
                "name": "Ajay Example",
                "email": "ajay@example.com",
                "address": "12 Main Street, Jaipur",
                "latitude": 26.9124,
                "longitude": 75.7873,
                "accuracy": 18,
            },
        )
        self.assertEqual(response.status_code, 201)
        result = response.get_json()
        self.assertEqual(result["total"], 1198)
        self.assertEqual(self.client.get("/api/cart").get_json()["count"], 0)

        order = self.query_one(
            "SELECT total, latitude, longitude, location_accuracy FROM orders WHERE id = ?",
            (result["orderId"],),
        )
        item_count = self.query_one(
            "SELECT COUNT(*) FROM order_items WHERE order_id = ?",
            (result["orderId"],),
        )[0]
        self.assertEqual(order["total"], 1198)
        self.assertEqual(order["latitude"], 26.9124)
        self.assertEqual(order["longitude"], 75.7873)
        self.assertEqual(order["location_accuracy"], 18)
        self.assertEqual(item_count, 1)

    def test_checkout_requires_login_and_keeps_guest_cart(self):
        self.request_json(
            "POST",
            "/api/cart",
            {"productId": "wireless-headphones"},
        )
        response = self.request_json(
            "POST",
            "/api/checkout",
            {
                "name": "Ajay Example",
                "email": "ajay@example.com",
                "address": "12 Main Street, Jaipur",
            },
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.client.get("/api/cart").get_json()["count"], 1)

    def test_login_and_order_history_require_authentication(self):
        self.assertEqual(self.client.get("/api/orders").status_code, 401)
        self.assertEqual(self.register().status_code, 201)
        self.assertEqual(self.client.post("/api/logout", headers={
            "X-CSRF-Token": self.csrf_token
        }).status_code, 200)
        self.csrf_token = self.client.get("/api/bootstrap").get_json()["csrfToken"]
        login = self.request_json(
            "POST",
            "/api/login",
            {"identity": "ajay@example.com", "password": "correct horse battery"},
        )
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.get_json()["user"]["username"], "ajay-demo")
        self.assertEqual(self.client.get("/api/orders").status_code, 200)

    def test_checkout_rejects_invalid_location_and_empty_cart(self):
        self.assertEqual(self.register().status_code, 201)
        empty_order = self.request_json(
            "POST",
            "/api/checkout",
            {
                "name": "Ajay",
                "email": "ajay@example.com",
                "address": "12 Main Street",
            },
        )
        self.assertEqual(empty_order.status_code, 400)

        self.request_json(
            "POST",
            "/api/cart",
            {"productId": "wireless-headphones"},
        )
        invalid_location = self.request_json(
            "POST",
            "/api/checkout",
            {
                "name": "Ajay",
                "email": "ajay@example.com",
                "address": "12 Main Street",
                "latitude": 200,
                "longitude": 77,
                "accuracy": 10,
            },
        )
        self.assertEqual(invalid_location.status_code, 400)

    def test_registered_seller_can_list_product_and_receive_demo_order(self):
        self.assertEqual(self.register().status_code, 201)
        product_response = self.request_json(
            "POST",
            "/api/seller/products",
            {
                "name": "Handmade Desk Lamp",
                "category": "home",
                "price": 1499,
                "stock": 2,
                "description": "A handmade lamp for a reading desk.",
                "imageUrl": "https://example.com/lamp.jpg",
            },
        )
        self.assertEqual(product_response.status_code, 201)
        product_id = product_response.get_json()["productId"]
        catalog_product = next(
            product for product in self.client.get("/api/bootstrap").get_json()["products"]
            if product["id"] == product_id
        )
        self.assertEqual(catalog_product["stock"], 2)
        self.assertEqual(catalog_product["imageUrl"], "https://example.com/lamp.jpg")

        invalid_image = self.request_json(
            "POST",
            "/api/seller/products",
            {
                "name": "Unsafe image",
                "category": "home",
                "price": 100,
                "stock": 1,
                "description": "An invalid image URL should be rejected.",
                "imageUrl": "http://example.com/lamp.jpg",
            },
        )
        self.assertEqual(invalid_image.status_code, 400)

        self.request_json("POST", "/api/logout", {})
        self.csrf_token = self.client.get("/api/bootstrap").get_json()["csrfToken"]
        buyer = self.request_json(
            "POST",
            "/api/register",
            {
                "username": "buyer-demo",
                "email": "buyer@example.com",
                "password": "correct horse battery",
            },
        )
        self.assertEqual(buyer.status_code, 201)
        self.csrf_token = buyer.get_json()["csrfToken"]
        self.request_json("POST", "/api/cart", {"productId": product_id})
        oversell = self.request_json(
            "POST",
            "/api/cart",
            {"productId": product_id, "quantity": 2},
        )
        self.assertEqual(oversell.status_code, 400)
        oversell_update = self.request_json(
            "PUT",
            "/api/cart/" + product_id,
            {"quantity": 3},
        )
        self.assertEqual(oversell_update.status_code, 400)
        order = self.request_json(
            "POST",
            "/api/checkout",
            {
                "name": "Buyer Example",
                "email": "buyer@example.com",
                "address": "42 Market Road, Jaipur",
            },
        )
        self.assertEqual(order.status_code, 201)
        self.assertEqual(order.get_json()["total"], 1499)
        self.assertEqual(
            self.query_one("SELECT stock FROM products WHERE id = ?", (product_id,))[0],
            1,
        )

        self.request_json("POST", "/api/logout", {})
        self.csrf_token = self.client.get("/api/bootstrap").get_json()["csrfToken"]
        seller_login = self.request_json(
            "POST",
            "/api/login",
            {"identity": "ajay-demo", "password": "correct horse battery"},
        )
        self.assertEqual(seller_login.status_code, 200)
        self.csrf_token = seller_login.get_json()["csrfToken"]
        seller_orders = self.client.get("/api/seller/orders").get_json()["orders"]
        self.assertEqual(len(seller_orders), 1)
        self.assertEqual(seller_orders[0]["customerEmail"], "buyer@example.com")
        self.assertEqual(seller_orders[0]["sellerTotal"], 1499)

    def test_product_listing_requires_login_and_rejects_invalid_stock(self):
        product = {
            "name": "Small vase",
            "category": "home",
            "price": 250,
            "stock": 1,
            "description": "Handmade ceramic vase.",
        }
        response = self.request_json("POST", "/api/seller/products", product)
        self.assertEqual(response.status_code, 401)

        self.assertEqual(self.register().status_code, 201)
        product["stock"] = 0
        response = self.request_json("POST", "/api/seller/products", product)
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
