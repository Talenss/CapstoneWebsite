import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';

/** Port of 04_Website/app/index.html — the landing page. Static content;
 *  no API calls (the header itself checks session state for the auth CTA). */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {}
